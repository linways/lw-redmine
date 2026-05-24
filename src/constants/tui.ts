/**
 * TUI configuration: keybindings, refresh cadence, layout.
 *
 * The TUI is built in Phase 3 (Ink). These constants exist now so they are
 * the single, fork-friendly source of truth from day one — no scattered
 * literals when we get there.
 */

export const TUI_REFRESH_INTERVAL_MS = 30_000;

/**
 * Vim-style by default. Each action maps to one or more key sequences.
 * A future user can rebind any action by editing this object.
 */
export const TUI_KEYBINDINGS = {
  quit: ['q', 'ctrl+c'],
  help: ['?'],
  refresh: ['r'],
  search: ['/'],
  commandPalette: [':'],

  next: ['j', 'down'],
  prev: ['k', 'up'],
  pageDown: ['ctrl+d', 'pagedown'],
  pageUp: ['ctrl+u', 'pageup'],
  pageTop: ['g', 'g'],
  pageBottom: ['shift+g', 'end'],

  open: ['enter', 'o'],
  edit: ['e'],
  changeStatus: ['s'],
  changeAssignee: ['a'],
  changePriority: ['p'],
  addNote: ['n'],
  watchToggle: ['w'],

  back: ['escape', 'h', 'left'],
} as const;

export const TUI_LAYOUT = {
  sidebarWidthPct: 30,
  detailWidthPct: 70,
  helpOverlayCols: 60,
} as const;

/** Default landing view when `lwr dash` is launched without args. */
export const TUI_DEFAULT_VIEW = 'inbox';
