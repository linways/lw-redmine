/**
 * EXPERIMENTAL — `lwr route`: natural-language request → lwr command, decided
 * by TypeSafe's Jev "System One" model (https://docs.typesafe.ai).
 *
 * Only the user's request text + the command catalog leave the machine —
 * never issue data.
 */

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-latest';
/** Env var holding the Jev API key (Bearer token). */
export const JEV_API_KEY_ENV = 'JEV_API';
export const JEV_TIMEOUT_MS = 8_000;
/** Command descriptions are clipped to this many chars in the Jev criteria. */
export const JEV_DESCRIPTION_MAX = 300;

/** Choice confidence at/above which `action` is "run". Measured: every misroute in probing was ≤ 0.6. */
export const ROUTE_CONFIDENT = 0.8;
/** needs_clarification probability at/above which `action` is "ask". */
export const ROUTE_CLARIFY = 0.7;

/** Facts about lwr Jev can't infer from the catalog alone (sent as part of state). */
export const ROUTE_CONTEXT =
  'lwr is a Redmine CLI. It already knows the logged-in user, their roles, and their current/active issue, ' +
  'so phrases like "my current issue", "what I am working on", or "my issues" are fully specified.';
