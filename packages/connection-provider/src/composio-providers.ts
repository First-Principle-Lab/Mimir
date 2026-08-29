import { ComposioConnectionProvider } from "./composio-provider.js";
import type { IntegrationConnectionStore } from "./types.js";
import { GMAIL_INTEGRATION } from "./nango-provider.js";

// The Composio-backed roster that shares the ConnectionProvider seam
// (gmail is handled by gmailProvider's swap factory; these are the rest).
// Each entry is the per-toolkit dashboard config: the Composio toolkit slug
// used to locate the user's connected account, the env var holding the
// toolkit's auth config id, and a cheap authenticated GET used as the
// syncConnection health probe (same transport as the data path).
export const GOOGLE_CALENDAR_INTEGRATION = "googlecalendar";
export const GITHUB_INTEGRATION = "github";
export const NOTION_INTEGRATION = "notion";

const TOOLKITS: Record<string, { toolkitSlug: string; authConfigKey: string; probePath: string }> = {
  [GMAIL_INTEGRATION]: {
    toolkitSlug: "gmail",
    authConfigKey: "COMPOSIO_GMAIL_AUTH_CONFIG",
    probePath: "/gmail/v1/users/me/profile",
  },
  [GOOGLE_CALENDAR_INTEGRATION]: {
    toolkitSlug: "googlecalendar",
    authConfigKey: "COMPOSIO_CALENDAR_AUTH_CONFIG",
    // Composio's calendar proxy strips the /calendar/v3 prefix — paths are
    // relative to www.googleapis.com, so users/me/calendarList (verified live).
    probePath: "/users/me/calendarList",
  },
  [GITHUB_INTEGRATION]: {
    toolkitSlug: "github",
    authConfigKey: "COMPOSIO_GITHUB_AUTH_CONFIG",
    probePath: "/user",
  },
  [NOTION_INTEGRATION]: {
    toolkitSlug: "notion",
    authConfigKey: "COMPOSIO_NOTION_AUTH_CONFIG",
    probePath: "/v1/users/me",
  },
};

// The IntegrationConnection.provider keys routed to Composio (gmail is the
// swap factory's providerKey="google-mail", listed here too so callers can ask
// "is this key Composio-backed?" without maintaining a second roster).
export const COMPOSIO_KEYS = [
  GMAIL_INTEGRATION,
  GOOGLE_CALENDAR_INTEGRATION,
  GITHUB_INTEGRATION,
  NOTION_INTEGRATION,
];

export interface ComposioRosterEnv {
  COMPOSIO_API_KEY?: string;
  COMPOSIO_BASE_URL?: string;
  COMPOSIO_GMAIL_AUTH_CONFIG?: string;
  COMPOSIO_CALENDAR_AUTH_CONFIG?: string;
  COMPOSIO_GITHUB_AUTH_CONFIG?: string;
  COMPOSIO_NOTION_AUTH_CONFIG?: string;
}

// One factory for the whole Composio row of the roster — no per-provider
// provider class, no per-provider route. slug/env/probe come from the map
// above, so a new toolkit is one entry + one env key.
export function composioProvider(
  key: string,
  env: ComposioRosterEnv,
  store: IntegrationConnectionStore,
  callbackUrl?: string,
): ComposioConnectionProvider {
  const toolkit = TOOLKITS[key];
  if (!toolkit) throw new Error(`unknown composio integration: ${key}`);
  return new ComposioConnectionProvider({
    apiKey: env.COMPOSIO_API_KEY,
    baseUrl: env.COMPOSIO_BASE_URL,
    authConfigId: env[toolkit.authConfigKey as keyof ComposioRosterEnv],
    callbackUrl,
    store,
    providerKey: key,
    toolkitSlug: toolkit.toolkitSlug,
    probePath: toolkit.probePath,
  });
}