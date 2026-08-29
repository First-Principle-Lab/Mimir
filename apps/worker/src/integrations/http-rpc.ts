import { ConnectionError, ProviderError } from "@mimir/connection-provider";
import type { ApiRequestOptions, ApiRequestResult } from "@mimir/connection-provider";

// The shared status -> {ConnectionError|ProviderError} mapping for the provider
// REST transports that surface `{ status, data }` (Composio proxyExecute, Nango
// rollback). Gmail used to own a copy inside gmail.ts; calendar/github/notion
// reuse this one so a fix lands everywhere, not just the provider the bug
// showed in.
//
// ConnectionError is fail-fast (reconnect, no retry); ProviderError is rethrown
// into BullMQ's attempts:5 backoff.
export interface RpcOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | string[]>;
  // Extra HTTP headers (e.g. Notion's Notion-Version) forwarded to the
  // provider transport unchanged.
  headers?: Record<string, string>;
}

export type RequestFn = (path: string, opts?: ApiRequestOptions) => Promise<ApiRequestResult>;

export async function rpc<T>(request: RequestFn, path: string, opts: RpcOptions = {}): Promise<T> {
  const res = await request(path, opts);
  if (res.status === 401 || res.status === 403) throw new ConnectionError("expired", "connection token rejected");
  if (res.status === 429) throw new ProviderError("rate_limited", "provider rate limited");
  if (res.status === 400) throw new ProviderError("validation_failed", "provider rejected request");
  if (res.status === 204) return undefined as T;
  if (res.status >= 500) throw new ProviderError("provider_down", `provider api ${res.status}`);
  if (res.status < 200 || res.status >= 300) throw new Error(`provider api returned ${res.status}`);
  return res.data as T;
}