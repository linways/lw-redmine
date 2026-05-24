/**
 * Public surface of the memory module.
 *
 * Consumers (lwr's assistant, future CLIs) import ONLY from this entry
 * point. Everything else inside `src/memory/` is internal.
 *
 * Boundary contract (enforced by review):
 *   - This module imports from `node:*` and `better-sqlite3` only.
 *   - One exception: `src/foundation/paths.ts` for the on-disk location, and
 *     `src/constants/memory.ts` for the schema name.
 *   - NO imports from `src/assistant/`, `src/commands/`, `src/api/`,
 *     or `src/foundation/run.ts`. If a future feature needs cross-module
 *     glue, that glue lives in the caller, not here.
 */

export { retain, deriveMemoryId } from './retain';
export { recall } from './recall';
export { openMemoryDb, closeMemoryDb, deleteMemoryDb } from './storage';
export {
  pruneOldObservations,
  readLastPruneAt,
  _resetAutoPruneThrottle,
  type PruneResult,
} from './prune';
export { getMemoryStatus, type MemoryStatus } from './status';
export type {
  MemoryKind,
  MemoryMetadata,
  MemoryRow,
  RetainInput,
  RetainResult,
  RecallOptions,
  RecallResult,
} from './types';
