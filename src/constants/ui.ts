/**
 * Visual styling for Pretty mode output: colors, table widths, spinners.
 *
 * Color values are kept abstract (named picocolors keys) where possible so
 * the palette is portable across terminals. Hex codes only appear for cases
 * the TUI later picks up directly.
 */

export const COLORS = {
  brand: '#7C3AED',
  success: '#10B981',
  warning: '#F59E0B',
  error: '#EF4444',
  dim: '#6B7280',

  /** Status name → picocolors method name. Lowercase keys (normalised). */
  status: {
    new: 'blue',
    'in progress': 'yellow',
    resolved: 'green',
    feedback: 'magenta',
    closed: 'gray',
    rejected: 'red',
  } as Record<string, string>,

  /** Priority name → picocolors method name. */
  priority: {
    low: 'gray',
    normal: 'white',
    high: 'yellow',
    urgent: 'red',
    immediate: 'magentaBright',
  } as Record<string, string>,
} as const;

/** Symbols used in Pretty output. Kept ASCII-safe by default. */
export const SYMBOLS = {
  success: '✓',
  failure: '✗',
  warning: '⚠',
  skip: '·',
  arrow: '→',
  bullet: '•',
  priorityDot: '●',
  sectionMarker: '▶',
} as const;

export const TABLE_MAX_COL_WIDTH = 50;
export const TABLE_STYLE = {
  rounded: { 'top': '─', 'top-mid': '┬', 'top-left': '╭', 'top-right': '╮' },
} as const;

/** Spinner style — name from the `cli-spinners` set used by `ora`. */
export const SPINNER_STYLE = 'dots12';
