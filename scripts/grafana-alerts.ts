import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnv } from "./_env.js";

// Applies grafana/alerting/*.yaml (Slack contact point, notification policy,
// alert rules) to a Grafana instance through its alerting provisioning API.
// Grafana Cloud has no file provisioning, so this is how the rules go live;
// self-hosted Grafana can mount the same files instead.
//
//   GRAFANA_URL=https://<stack>.grafana.net GRAFANA_TOKEN=<service account token> \
//   MIMIR_PROMETHEUS_UID=<prom datasource uid> SLACK_WEBHOOK_URL=<incoming webhook> \
//   bun scripts/grafana-alerts.ts [--check] [--test-slack]
//
// --check validates the files and the data source without writing anything.
// --test-slack also sends Grafana's test notification through the contact point.
// GRAFANA_USER/GRAFANA_PASSWORD (basic auth) work instead of a token locally.

loadEnv();
const check = process.argv.includes("--check");
const testSlack = process.argv.includes("--test-slack");
const dir = join(import.meta.dir, "..", "grafana", "alerting");

const required = ["GRAFANA_URL", "MIMIR_PROMETHEUS_UID", "SLACK_WEBHOOK_URL"];
const missing = required.filter((k) => !process.env[k]);
if (!process.env.GRAFANA_TOKEN && !process.env.GRAFANA_USER)
  missing.push("GRAFANA_TOKEN (or GRAFANA_USER/GRAFANA_PASSWORD)");
if (missing.length) {
  console.error(`missing: ${missing.join(", ")}`);
  process.exit(64);
}

// ${VAR} expansion, as Grafana does for provisioning files. Template text
// such as {{ .Status }} is left alone.
function load(name: string): Record<string, unknown> {
  const text = readFileSync(join(dir, name), "utf8").replace(
    /\$\{([A-Z0-9_]+)\}/g,
    (_, key: string) => {
      const value = process.env[key];
      if (value === undefined) throw new Error(`${name}: ${key} is not set`);
      return value;
    },
  );
  return Bun.YAML.parse(text) as Record<string, unknown>;
}

const base = process.env.GRAFANA_URL!.replace(/\/+$/, "");
const auth = process.env.GRAFANA_TOKEN
  ? `Bearer ${process.env.GRAFANA_TOKEN}`
  : `Basic ${btoa(`${process.env.GRAFANA_USER}:${process.env.GRAFANA_PASSWORD ?? ""}`)}`;

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: {
      Authorization: auth,
      "Content-Type": "application/json",
      // Keep provisioned resources editable in the UI for incident tweaks.
      "X-Disable-Provenance": "true",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function expect(ok: boolean, what: string, detail?: unknown): void {
  if (ok) return;
  console.error(`FAILED: ${what}`, detail ?? "");
  process.exit(1);
}

type Receiver = {
  uid: string;
  type: string;
  settings: Record<string, unknown>;
  disableResolveMessage?: boolean;
};
type Rule = Record<string, unknown> & { uid: string; for: string };
type Group = { name: string; folder: string; interval: string; rules: Rule[] };

const contactPoints = (
  load("contact-points.yaml").contactPoints as {
    name: string;
    receivers: Receiver[];
  }[]
).flatMap((cp) => cp.receivers.map((r) => ({ ...r, name: cp.name })));
const policy = (
  load("policies.yaml").policies as Record<string, unknown>[]
)[0]!;
const groups = load("rules.yaml").groups as Group[];

const seconds = (d: string) => {
  const m = /^(\d+)([smh])$/.exec(d);
  if (!m) throw new Error(`bad duration ${d}`);
  return Number(m[1]) * { s: 1, m: 60, h: 3600 }[m[2] as "s" | "m" | "h"];
};

const ds = await api(
  "GET",
  `/api/datasources/uid/${encodeURIComponent(process.env.MIMIR_PROMETHEUS_UID!)}`,
);
expect(ds.status === 200, "Prometheus data source exists", ds.body);
for (const group of groups)
  for (const rule of group.rules) {
    const data = rule.data as { model: { expr?: string } }[];
    // Parse every query against the data source before writing anything.
    const expr = data[0]!.model.expr!;
    const probe = await api(
      "GET",
      `/api/datasources/proxy/uid/${process.env.MIMIR_PROMETHEUS_UID}/api/v1/query?query=${encodeURIComponent(expr)}`,
    );
    expect(probe.status === 200, `query of ${rule.uid} is valid`, probe.body);
  }
console.log(
  `validated ${contactPoints.length} contact point(s), 1 policy tree, ${groups.reduce((n, g) => n + g.rules.length, 0)} rule(s)`,
);
if (check) process.exit(0);

for (const cp of contactPoints) {
  const body = {
    uid: cp.uid,
    name: cp.name,
    type: cp.type,
    settings: cp.settings,
    disableResolveMessage: cp.disableResolveMessage ?? false,
  };
  const updated = await api(
    "PUT",
    `/api/v1/provisioning/contact-points/${cp.uid}`,
    body,
  );
  if (updated.status !== 202) {
    const created = await api(
      "POST",
      "/api/v1/provisioning/contact-points",
      body,
    );
    expect(
      [200, 201, 202].includes(created.status),
      `contact point ${cp.uid}`,
      created.body,
    );
  }
}

for (const group of groups) {
  const folderUid = group.folder.toLowerCase();
  const folder = await api("POST", "/api/folders", {
    uid: folderUid,
    title: group.folder,
  });
  expect(
    [200, 409, 412].includes(folder.status) ||
      /already exists/i.test(JSON.stringify(folder.body)),
    `folder ${group.folder}`,
    folder.body,
  );
  const put = await api(
    "PUT",
    `/api/v1/provisioning/folder/${folderUid}/rule-groups/${encodeURIComponent(group.name)}`,
    {
      title: group.name,
      folderUid,
      interval: seconds(group.interval),
      rules: group.rules.map((rule) => ({
        ...rule,
        folderUID: folderUid,
        ruleGroup: group.name,
        orgID: 1,
      })),
    },
  );
  expect(put.status === 200, `rule group ${group.name}`, put.body);
}

const policies = await api("PUT", "/api/v1/provisioning/policies", policy);
expect(policies.status === 202, "notification policy", policies.body);
console.log("applied contact points, rules and notification policy");

if (testSlack) {
  const cp = contactPoints[0]!;
  // Grafana 12+ tests a stored receiver through its app-platform API (the
  // namespace is "default" self-hosted, "stacks-<id>" on Grafana Cloud).
  // Older versions only have the legacy alertmanager endpoint.
  const namespace = process.env.GRAFANA_NAMESPACE ?? "default";
  const name = btoa(cp.name).replace(/=+$/, "");
  const path = `/apis/notifications.alerting.grafana.app/v1beta1/namespaces/${namespace}/receivers/${name}`;
  const stored = await api("GET", path);
  let sent;
  if (stored.status === 200) {
    const integration = (
      stored.body as { spec: { integrations: { uid: string }[] } }
    ).spec.integrations.find((i) => i.uid === cp.uid);
    sent = await api("POST", `${path}/test`, { integration });
    expect(
      sent.status === 200 &&
        (sent.body as { status?: string }).status === "success",
      "test notification",
      sent.body,
    );
  } else {
    sent = await api(
      "POST",
      "/api/alertmanager/grafana/config/api/v1/receivers/test",
      {
        receivers: [
          {
            name: cp.name,
            grafana_managed_receiver_configs: [
              {
                uid: cp.uid,
                name: cp.name,
                type: cp.type,
                settings: cp.settings,
              },
            ],
          },
        ],
      },
    );
    expect(sent.status === 200, "test notification", sent.body);
  }
  console.log("test notification sent to", cp.name);
}
