import * as Sentry from "@sentry/node";
import { PrismaInstrumentation } from "@prisma/instrumentation";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { ConsoleSpanExporter } from "@opentelemetry/sdk-trace-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { trace } from "@opentelemetry/api";
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_NAMESPACE,
} from "@opentelemetry/semantic-conventions";
import { getConfig } from "./config/config.js";

// Module-scope side effect: this file MUST be imported before prisma so the
// Prisma instrumentation registers before that module loads (see app entrypoints).
const cfg = getConfig();

// Application entrypoints create request/job spans manually with this tracer:
// the http/express OTel instrumentations silently no-op under Bun (the runtime
// used here and in the prod images), so relying on them yields zero HTTP spans.
export const tracer = trace.getTracer("mimir");

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: cfg.OTEL_SERVICE_NAME ?? "mimir",
    [ATTR_SERVICE_NAMESPACE]: "mimir",
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: cfg.NODE_ENV ?? "development",
  }),
  traceExporter: cfg.OTEL_EXPORTER_OTLP_ENDPOINT
    ? new OTLPTraceExporter({
        url: signalUrl(cfg.OTEL_EXPORTER_OTLP_ENDPOINT, "traces"),
        headers: parseOtlpHeaders(cfg.OTEL_EXPORTER_OTLP_HEADERS),
      })
    : new ConsoleSpanExporter(),
  // Metrics (metrics.ts) go to the same OTLP endpoint; Grafana alerts on them.
  // Without an endpoint none are collected (an empty list also stops the SDK
  // from defaulting to an exporter aimed at localhost).
  metricReaders: cfg.OTEL_EXPORTER_OTLP_ENDPOINT
    ? [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({
            url: signalUrl(cfg.OTEL_EXPORTER_OTLP_ENDPOINT, "metrics"),
            headers: parseOtlpHeaders(cfg.OTEL_EXPORTER_OTLP_HEADERS),
          }),
          exportIntervalMillis: 30_000,
        }),
      ]
    : [],
  instrumentations: [new PrismaInstrumentation()],
});
sdk.start();

if (cfg.SENTRY_DSN) {
  Sentry.init({
    dsn: cfg.SENTRY_DSN,
    environment: cfg.NODE_ENV ?? "development",
  });
}

function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const headers: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    headers[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return headers;
}

// The OTLPHTTP exporter takes the passed url verbatim; the OTel env var spec treats
// OTEL_EXPORTER_OTLP_ENDPOINT as a base URL and appends /v1/<signal>. Normalize so
// Grafana Cloud's documented endpoint (".../otlp") works as-is.
export function signalUrl(
  endpoint: string,
  signal: "traces" | "metrics",
): string {
  const base = endpoint
    .replace(/\/v1\/(traces|metrics)\/?$/, "")
    .replace(/\/+$/, "");
  return `${base}/v1/${signal}`;
}
