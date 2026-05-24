/**
 * Assistant feature-flag state.
 *
 * Single source of truth: `config.assistant.enabled` in `~/.lwr/config.json`.
 * Every assistant-aware code path consults `isAssistantEnabled()` before
 * doing anything; with the flag off, the assistant layer is a complete
 * no-op (no files written, no callbacks fired, no behaviour change).
 *
 * Phase 3 foundation tier — only the flag exists. Subsequent tiers add
 * the events log, taught knowledge, inference, etc., all gated on the
 * same bit.
 */

import { loadConfig, updateConfig } from '../foundation/config';
import { activeProfile } from '../foundation/profiles';

export interface AssistantState {
  enabled: boolean;
}

/** Read the current state without mutating anything. Cheap. */
export function getAssistantState(): AssistantState {
  return { enabled: loadConfig().assistant.enabled };
}

/** Convenience: just the bit. Used at every assistant-aware code path. */
export function isAssistantEnabled(): boolean {
  return getAssistantState().enabled;
}

/** Flip the flag on. Returns the new state (stable shape for JSON callers). */
export function enableAssistant(): AssistantState {
  updateConfig(cfg => ({ ...cfg, assistant: { ...cfg.assistant, enabled: true } }));
  return { enabled: true };
}

/** Flip the flag off. Returns the new state. */
export function disableAssistant(): AssistantState {
  updateConfig(cfg => ({ ...cfg, assistant: { ...cfg.assistant, enabled: false } }));
  return { enabled: false };
}

/**
 * Stable bank identifier for the memory module. One bank per profile —
 * different Redmine instances stay isolated. Falls back to "default"
 * when no profile is active (very early startup, fresh install).
 *
 * Memory module is bank-keyed: every retain/recall call passes this id,
 * which means recall results never cross profile boundaries.
 */
export function memoryBankId(): string {
  try {
    return activeProfile().name;
  } catch {
    return 'default';
  }
}
