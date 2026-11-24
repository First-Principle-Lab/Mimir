import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");

test("eval outcome reaches OTLP with suite attribution and reports collector errors", async () => {
  const received: { path: string; auth?: string; body: unknown }[] = [];
  let status = 200;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({
      path: req.url!,
      auth: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString()),
    });
    res.writeHead(status).end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const run = async (code: number) => {
    const child = Bun.spawn(
      [
        process.execPath,
        "scripts/eval/report-metrics.ts",
        "harness",
        String(code),
      ],
      {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
          OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer synthetic",
        },
      },
    );
    return child.exited;
  };
  try {
    expect(await run(1)).toBe(0);
    expect(received[0]?.path).toBe("/v1/metrics");
    expect(received[0]?.auth).toBe("Bearer synthetic");
    const payload = received[0]!.body as {
      resourceMetrics: {
        scopeMetrics: {
          metrics: {
            gauge: {
              dataPoints: { asDouble: number; attributes: unknown[] }[];
            };
          }[];
        }[];
      }[];
    };
    const point =
      payload.resourceMetrics[0]!.scopeMetrics[0]!.metrics[0]!.gauge
        .dataPoints[0]!;
    expect(point.asDouble).toBe(0);
    expect(point.attributes).toEqual([
      { key: "suite", value: { stringValue: "harness" } },
    ]);
    status = 503;
    expect(await run(0)).toBe(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("Grafana check validates every rule through Prometheus without mutating resources", async () => {
  const requests: { method: string; path: string }[] = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method!, path: req.url! });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ status: "success", data: { result: [] } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    const child = Bun.spawn(
      [process.execPath, "scripts/grafana-alerts.ts", "--check"],
      {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          GRAFANA_URL: `http://127.0.0.1:${port}`,
          GRAFANA_TOKEN: "synthetic",
          MIMIR_PROMETHEUS_UID: "prometheus",
          SLACK_WEBHOOK_URL: "https://example.test/synthetic",
        },
      },
    );
    expect(await child.exited).toBe(0);
    expect(requests).toHaveLength(13); // datasource plus all twelve rules
    expect(requests.every((r) => r.method === "GET")).toBe(true);
    expect(
      requests.some((r) =>
        decodeURIComponent(r.path).includes("mimir_eval_pass"),
      ),
    ).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
