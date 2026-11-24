import {
  metrics,
  type Attributes,
  type Counter,
  type Histogram,
  type MeterProvider,
} from "@opentelemetry/api";

// Application metrics, exported over OTLP next to traces (observability.ts)
// and alerted on in Grafana (grafana/alerting). Names are final Prometheus
// names: counters gain `_total` on export, nothing else is renamed.
//
// Instruments are created on first use from whichever provider is global at
// that moment, and rebuilt if it changes (tests install their own).

let provider: MeterProvider | null = null;
const counters = new Map<string, Counter>();
const histograms = new Map<string, Histogram>();

function meter() {
  const current = metrics.getMeterProvider();
  if (current !== provider) {
    provider = current;
    counters.clear();
    histograms.clear();
  }
  return current.getMeter("mimir");
}

function count(name: string, help: string, attrs: Attributes, n = 1): void {
  const m = meter();
  let c = counters.get(name);
  if (!c)
    counters.set(name, (c = m.createCounter(name, { description: help })));
  c.add(n, attrs);
}

const SECONDS_BUCKETS = [
  0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5, 10, 30, 60, 120, 300, 600,
];

function observe(
  name: string,
  help: string,
  value: number,
  attrs: Attributes,
): void {
  const m = meter();
  let h = histograms.get(name);
  if (!h)
    histograms.set(
      name,
      (h = m.createHistogram(name, {
        description: help,
        advice: { explicitBucketBoundaries: SECONDS_BUCKETS },
      })),
    );
  h.record(value, attrs);
}

export function recordHttpRequest(
  method: string,
  route: string,
  status: number,
  seconds: number,
): void {
  observe(
    "mimir_http_request_duration_seconds",
    "API request duration",
    seconds,
    {
      method,
      route,
      status_class: `${Math.floor(status / 100)}xx`,
    },
  );
}

export function recordJob(
  queue: string,
  outcome: "completed" | "failed" | "delayed",
  seconds: number,
  lagSeconds?: number,
): void {
  observe("mimir_job_duration_seconds", "Worker job run time", seconds, {
    queue,
    outcome,
  });
  if (lagSeconds !== undefined)
    observe(
      "mimir_job_lag_seconds",
      "Time from enqueue to job start",
      lagSeconds,
      { queue },
    );
}

// A turn's end-to-end time from its oldest input to the settled reply.
export function recordTurn(mode: "chat" | "ambient", seconds: number): void {
  observe("mimir_turn_duration_seconds", "Harness turn duration", seconds, {
    mode,
  });
}

// Every failure path that is handled (logged and survived) also counts here,
// so it is visible on a dashboard and alertable, not just a log line.
export function recordFailure(component: string, reason: string): void {
  count("mimir_failures", "Handled failures by component", {
    component,
    reason,
  });
}

export function recordBudgetCrossing(state: "soft" | "hard"): void {
  count("mimir_budget_crossings", "Users crossing a daily budget limit", {
    state,
  });
}

export function recordBudgetRejection(surface: string): void {
  count(
    "mimir_budget_rejections",
    "Work refused or paused by the hard budget",
    {
      surface,
    },
  );
}

export function recordDelivery(channel: string, n = 1): void {
  count("mimir_deliveries", "Deliveries by channel", { channel }, n);
}

// Observable gauge read at each export. The callback may query Redis or
// Postgres; failures are counted and the gauge skips that collection.
export function registerGauge(
  name: string,
  help: string,
  read: () =>
    Array<[number, Attributes]> | Promise<Array<[number, Attributes]>>,
): void {
  const gauge = metrics
    .getMeterProvider()
    .getMeter("mimir")
    .createObservableGauge(name, { description: help });
  gauge.addCallback(async (result) => {
    try {
      for (const [value, attrs] of await read()) result.observe(value, attrs);
    } catch {
      recordFailure("metrics", name);
    }
  });
}
