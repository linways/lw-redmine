/**
 * Numeric helpers for the JSON output contract.
 *
 * Redmine returns hours as float64, so values stored as 2.5 sometimes
 * surface as 2.500000023841858. That noise leaks into our `--json`
 * envelope and looks unprofessional. We round at the api/ boundary so
 * downstream consumers (agents, scripts, table renderers) see clean
 * decimals.
 */

const HOURS_DECIMALS = 2;

/**
 * Round to 2 decimal places, preserving `null`/`undefined` as-is so we
 * don't accidentally synthesize zeros where the API explicitly returned
 * "no value".
 */
export function roundHours(n: number | null | undefined): number | null | undefined {
  if (n === null || n === undefined) return n;
  if (!Number.isFinite(n)) return n;
  const factor = 10 ** HOURS_DECIMALS;
  return Math.round(n * factor) / factor;
}
