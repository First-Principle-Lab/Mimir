import { loadEnv } from "../_env.js";

// CI and local immutable runs publish their pass/fail outcome to the same OTLP
// destination as the application. Never send fixture text or user identifiers.
loadEnv();
const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
if (!endpoint) {
  console.log("eval alert metrics not exported: OTEL endpoint is unset");
  process.exit(0);
}
const suite = process.argv[2]!;
const code = Number(process.argv[3]);
const headers: Record<string, string> = { "Content-Type": "application/json" };
for (const pair of (process.env.OTEL_EXPORTER_OTLP_HEADERS ?? "").split(",")) {
  const eq = pair.indexOf("=");
  if (eq > 0) headers[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
}
const timestamp = (BigInt(Date.now()) * 1_000_000n).toString();
try {
  const response = await fetch(
    endpoint.replace(/\/v1\/(traces|metrics)\/?$/, "").replace(/\/+$/, "") +
      "/v1/metrics",
    {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        resourceMetrics: [
          {
            resource: {
              attributes: [
                { key: "service.name", value: { stringValue: "mimir-eval" } },
              ],
            },
            scopeMetrics: [
              {
                scope: { name: "mimir.eval" },
                metrics: [
                  {
                    name: "mimir_eval_pass",
                    description:
                      "1 for a passing suite; 0 for failed or not run",
                    gauge: {
                      dataPoints: [
                        {
                          timeUnixNano: timestamp,
                          asDouble: code === 0 ? 1 : 0,
                          attributes: [
                            { key: "suite", value: { stringValue: suite } },
                          ],
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
    },
  );
  if (!response.ok) throw new Error(`OTLP returned ${response.status}`);
  console.log("eval outcome exported to Grafana");
} catch (error) {
  console.error(
    "eval alert metric export failed:",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
}
