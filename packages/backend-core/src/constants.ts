// Tunable values live here, never inline in app code.
// Import from "@mimir/backend-core" (main entry) or, if the importing module
// must stay side-effect-free (e.g. pure token helpers), use the subpath
// "@mimir/backend-core/constants".

// Auth — token lifetimes & cookie placement
export const ACCESS_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const REFRESH_TOKEN_COOKIE_PATH = "/api/v1/auth/refresh";

// Auth — password hashing & brute-force protection
export const BCRYPT_COST = 12;
export const LOGIN_RATE_MAX = 5;
export const LOGIN_RATE_WINDOW_SECONDS = 15 * 60;

// Auth — Google OAuth
export const GOOGLE_STATE_MAX_AGE_MS = 10 * 60 * 1000;

// Hosted browser sessions cost real money per minute. Keep the cap low enough
// that a runaway loop can't produce a surprise bill.
export const BROWSER_DAILY_MINUTES_CAP = 30; // per-user per-day hosted-browser minutes

// BullMQ queue the api enqueues user turns on and the worker's harness consumes.
export const CONVERSATION_TURNS = "conversation-turns";

// Harness (pi) — the interaction agent's run loop.
export const HARNESS_TURN_TIMEOUT_MS = 120_000; // abort a run that hasn't settled by then
export const HARNESS_TOOL_OUTPUT_MAX_CHARS = 12_000; // cap each tool result the model sees; longer output is truncated with a note
export const HARNESS_LOCK_TTL_MS = 150_000; // per-conversation run lock; > HARNESS_TURN_TIMEOUT_MS so a live run never loses it
export const HARNESS_FACTS_MIN_MESSAGES = 50; // inject remembered facts into the runtime context once a thread is this long
export const HARNESS_LEGACY_HISTORY_LIMIT = 50; // seed this many v1 messages on the first pi turn; older facts remain searchable

// How many active ExtractedFacts to inject into reply context on a top-K embedding
// search. Bounded to keep prompt context lean.
export const FACT_EXTRACTION_TOP_K = 5;

// Reciprocal Rank Fusion constant (1/(K+rank)); the +K damps low ranks so a
// single cheap rank doesn't dominate the fused score.
export const FACT_RRF_K = 60;

// Hard cap on facts injected into reply context after relation expansion —
// relations can fan a top-K hit into many neighbors, so bound total injection.
export const FACT_INJECT_CAP = 10;
