/**
 * Public types for the `src/memory/` module.
 *
 * The module is consumer-agnostic. Lwr's `src/assistant/` is the first
 * caller; another CLI could embed the same module against a different
 * SQLite path. Keeping types here (and re-exported from `index.ts`)
 * means consumers never reach into the storage layer.
 */

import type { MemoryKind } from '../constants';

export type { MemoryKind } from '../constants';

/** Structured metadata attached to a memory. Keys are caller-defined. */
export type MemoryMetadata = Record<string, string | number | boolean | null>;

/**
 * A persisted memory row. `id` is a deterministic hash of
 * `(bankId, kind, metadata)` so two `retain()` calls describing the
 * same observation converge to the same row (with `seenCount++`).
 */
export interface MemoryRow {
  id: string;
  bankId: string;
  kind: MemoryKind;
  /** Human-readable description. Latest writer wins when seenCount bumps. */
  content: string;
  /** Structured metadata. Drives dedupe + recall filters. */
  metadata: MemoryMetadata;
  createdAt: number;
  lastSeenAt: number;
  seenCount: number;
  /**
   * When set, this memory was superseded by another (id). Recall hides
   * superseded rows by default; the suggester can opt-in via
   * `includeSuperseded: true` to surface conflicts.
   */
  supersededBy: string | null;
  /** Unix-ms when this row was marked superseded. Null while active. */
  supersededAt: number | null;
}

/** Input to `retain()`. */
export interface RetainInput {
  bankId: string;
  kind: MemoryKind;
  content: string;
  metadata?: MemoryMetadata;
  /**
   * Optional supersession filter. When provided, every prior active row
   * in the same (bankId, kind) whose metadata matches ALL of these
   * key/value pairs (and isn't the row being written) gets marked
   * `superseded_by = <new id>` and `superseded_at = now`.
   *
   * Use this for fact-shaped retains where a new assertion replaces a
   * prior one for the same subject (e.g. supersedeWhere={cf_id:79}
   * makes the new Tester=Maya fact retire the prior Tester=Alex Biju).
   */
  supersedeWhere?: MemoryMetadata;
}

/** Outcome of a `retain()` call. */
export interface RetainResult {
  id: string;
  /** True when this was a fresh insert; false when an existing row was bumped. */
  inserted: boolean;
  seenCount: number;
  /** Ids of prior rows that were marked superseded by this write. */
  supersededIds: string[];
}

/** Options for `recall()`. */
export interface RecallOptions {
  bankId: string;
  /** Filter by kind. Omit for all kinds. */
  kind?: MemoryKind;
  /** Filter rows whose `metadata` contains ALL of these key/value pairs. */
  metadataFilter?: MemoryMetadata;
  /** Cap on returned rows. Default 50. */
  topK?: number;
  /** Surface superseded rows (default: hide them). */
  includeSuperseded?: boolean;
}

/** Result of `recall()` — rows sorted by combined recency+frequency score. */
export interface RecallResult {
  rows: MemoryRow[];
  /** Total matching rows before topK was applied. */
  total: number;
}
