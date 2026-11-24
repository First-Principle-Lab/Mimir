import { describe, expect, test } from "bun:test";
import { metrics } from "@opentelemetry/api";
import {
  AggregationTemporality,
  MeterProvider,
  MetricReader,
} from "@opentelemetry/sdk-metrics";

process.env.DATABASE_URL ??= "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL ??= "redis://localhost:6380";
process.env.JWT_SECRET ??= "metrics-test-secret";

const m = await import("./metrics.js");
const { signalUrl } = await import("./observability.js");

class TestReader extends MetricReader {
  constructor() {
    super({
      aggregationTemporalitySelector: () => AggregationTemporality.CUMULATIVE,
    });
  }
  protected async onForceFlush() {}
  protected async onShutdown() {}
}

const reader = new TestReader();
metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));

async function collected() {
  const { resourceMetrics } = await reader.collect();
  const out = new Map<
    string,
    { attributes: Record<string, unknown>; value: unknown }[]
  >();
  for (const scope of resourceMetrics.scopeMetrics)
    for (const metric of scope.metrics)
      out.set(
        metric.descriptor.name,
        metric.dataPoints.map((p) => ({
          attributes: p.attributes,
          value: p.value,
        })),
      );
  return out;
}

describe("metrics", () => {
  test("records the series alert rules query", async () => {
    m.recordFailure("delivery", "drain");
    m.recordFailure("delivery", "drain");
    m.recordBudgetCrossing("hard");
    m.recordBudgetRejection("message");
    m.recordDelivery("push", 3);
    m.recordHttpRequest("POST", "/api/v1/message", 202, 0.04);
    m.recordJob("conversation-turns", "completed", 2, 0.5);
    m.recordTurn("chat", 4);
    m.registerGauge("mimir_test_gauge", "test", async () => [[7, { q: "x" }]]);
    m.registerGauge("mimir_test_broken", "test", async () => {
      throw new Error("db down");
    });

    const got = await collected();
    expect(got.get("mimir_failures")).toContainEqual({
      attributes: { component: "delivery", reason: "drain" },
      value: 2,
    });
    expect(got.get("mimir_budget_crossings")?.[0]?.value).toBe(1);
    expect(got.get("mimir_budget_rejections")?.[0]?.attributes).toEqual({
      surface: "message",
    });
    expect(got.get("mimir_deliveries")?.[0]?.value).toBe(3);
    expect(got.get("mimir_test_gauge")?.[0]).toEqual({
      attributes: { q: "x" },
      value: 7,
    });
    for (const name of [
      "mimir_http_request_duration_seconds",
      "mimir_job_duration_seconds",
      "mimir_job_lag_seconds",
      "mimir_turn_duration_seconds",
    ])
      expect(got.has(name)).toBe(true);
    const http = got.get("mimir_http_request_duration_seconds")![0]!;
    expect(http.attributes).toEqual({
      method: "POST",
      route: "/api/v1/message",
      status_class: "2xx",
    });
    // A gauge whose read fails is skipped and counted, not thrown.
    expect(got.has("mimir_test_broken")).toBe(false);
    expect(got.get("mimir_failures")).toContainEqual({
      attributes: { component: "metrics", reason: "mimir_test_broken" },
      value: 1,
    });
  });

  test("OTLP signal URLs follow the base-endpoint convention", () => {
    const base = "https://otlp-gateway.example.net/otlp";
    expect(signalUrl(base, "metrics")).toBe(`${base}/v1/metrics`);
    expect(signalUrl(`${base}/`, "traces")).toBe(`${base}/v1/traces`);
    expect(signalUrl(`${base}/v1/traces`, "metrics")).toBe(
      `${base}/v1/metrics`,
    );
  });
});
