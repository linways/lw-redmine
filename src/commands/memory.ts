/**
 * `lwr memory recall | status | prune`
 *
 * Surface over the assistant's memory store. Memory is auto-populated by
 * the observer + decisions pipeline (`kind: 'observation'`), by every
 * `lwr prefs add | remove` (`kind: 'fact'`), and by the rule-candidate
 * detector (`kind: 'rule-candidate'`). These commands are the read
 * and cleanup surface for that store.
 *
 * Agents use `lwr memory recall` to find prior context before writing
 * (the "recall-before-write" pattern that makes supersession work).
 * Humans use `lwr memory status` and `lwr memory prune` for diagnostics
 * and cleanup.
 */

import { runCommand, type CommandFn, type CommandResult, type GlobalFlags } from '../foundation/run';
import { writeLine } from '../foundation/output';
import { dim, header } from '../foundation/format';
import { ValidationError } from '../foundation/errors';
import { ERROR_CODES, MEMORY_KINDS, type MemoryKind } from '../constants';
import {
  recall,
  pruneOldObservations,
  getMemoryStatus,
  type MemoryRow,
  type MemoryStatus,
} from '../memory';
import { memoryBankId } from '../assistant/state';

// ---------------------------------------------------------------------------
// recall
// ---------------------------------------------------------------------------

interface RecallFlags extends GlobalFlags {
  query?: string;
  kind?: string;
  cfId?: string;
  ruleId?: string;
  limit?: string;
  includeSuperseded?: boolean;
}

interface RecallPayload {
  bankId: string;
  total: number;
  rows: MemoryRow[];
}

const recallCmd: CommandFn<RecallPayload> = async (
  flags,
): Promise<CommandResult<RecallPayload>> => {
  const f = flags as RecallFlags;
  const kind = parseKind(f.kind);
  const limit = parseLimit(f.limit);
  const metadataFilter = buildMetadataFilter(f);

  const bankId = memoryBankId();
  const result = recall({
    bankId,
    kind,
    metadataFilter,
    topK: limit,
    includeSuperseded: f.includeSuperseded ?? false,
  });

  // Optional case-insensitive substring filter on `content` — applied
  // in JS so we don't need a separate FTS index. Cheap for the row
  // counts memory carries (thousands, not millions).
  const filtered = f.query
    ? result.rows.filter(r =>
        r.content.toLowerCase().includes(f.query!.toLowerCase()),
      )
    : result.rows;

  return {
    json: {
      bankId,
      total: filtered.length,
      rows: filtered,
    },
    pretty: ctx => {
      writeLine(header(ctx, `memory recall — ${filtered.length} of ${result.total}`));
      writeLine(`${dim(ctx, 'bank:')} ${bankId}`);
      if (filtered.length === 0) {
        writeLine(dim(ctx, '  (no matching memories)'));
        return;
      }
      for (const row of filtered) {
        writeLine('');
        const marker = row.supersededBy ? dim(ctx, ' (superseded)') : '';
        writeLine(`  [${row.kind}] ${row.content}${marker}`);
        writeLine(
          `    ${dim(ctx, 'seen:')} ${row.seenCount}  ${dim(ctx, 'last:')} ${new Date(
            row.lastSeenAt,
          ).toISOString()}`,
        );
      }
    },
  };
};

function parseKind(raw?: string): MemoryKind | undefined {
  if (!raw) return undefined;
  if (!(MEMORY_KINDS as readonly string[]).includes(raw)) {
    throw new ValidationError(
      `Unknown --kind "${raw}".`,
      ERROR_CODES.VALIDATION_BAD_VALUE,
      `Allowed: ${MEMORY_KINDS.join(', ')}.`,
    );
  }
  return raw as MemoryKind;
}

function parseLimit(raw?: string): number {
  if (!raw) return 50;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || n > 1000) {
    throw new ValidationError(
      `--limit must be a positive integer ≤ 1000 (got "${raw}").`,
      ERROR_CODES.VALIDATION_BAD_VALUE,
    );
  }
  return n;
}

function buildMetadataFilter(
  f: RecallFlags,
): Record<string, string | number> | undefined {
  const filter: Record<string, string | number> = {};
  if (f.cfId !== undefined) {
    const n = Number.parseInt(f.cfId, 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw new ValidationError(
        `--cf-id must be a positive integer (got "${f.cfId}").`,
        ERROR_CODES.VALIDATION_BAD_VALUE,
      );
    }
    filter.cf_id = n;
  }
  if (f.ruleId !== undefined) {
    filter.rule_id = f.ruleId;
  }
  return Object.keys(filter).length > 0 ? filter : undefined;
}

export function recallMemory(flags: RecallFlags): Promise<never> {
  return runCommand('memory.recall', flags, recallCmd);
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

const statusCmd: CommandFn<MemoryStatus> = async (): Promise<
  CommandResult<MemoryStatus>
> => {
  const data = getMemoryStatus();
  return {
    json: data,
    pretty: ctx => {
      writeLine(header(ctx, 'lwr memory'));
      writeLine(`${dim(ctx, 'file :')} ${data.path}`);
      if (!data.exists) {
        writeLine(dim(ctx, '  (no memory recorded yet)'));
        return;
      }
      writeLine(`${dim(ctx, 'size :')} ${data.sizeBytes} bytes`);
      writeLine(`${dim(ctx, 'rows :')} ${data.totalRows} total`);
      for (const kind of MEMORY_KINDS) {
        writeLine(`         ${kind}: ${data.rowsByKind[kind]}`);
      }
      if (data.oldestAt) writeLine(`${dim(ctx, 'oldest:')} ${data.oldestAt}`);
      if (data.newestAt) writeLine(`${dim(ctx, 'newest:')} ${data.newestAt}`);
      if (data.lastPruneAt) writeLine(`${dim(ctx, 'pruned:')} ${data.lastPruneAt}`);
    },
  };
};

export function statusMemory(flags: GlobalFlags): Promise<never> {
  return runCommand('memory.status', flags, statusCmd);
}

// ---------------------------------------------------------------------------
// prune
// ---------------------------------------------------------------------------

interface PrunePayload {
  deleted: number;
  lastPruneAt: string;
}

const pruneCmd: CommandFn<PrunePayload> = async (): Promise<
  CommandResult<PrunePayload>
> => {
  const result = pruneOldObservations();
  return {
    json: {
      deleted: result.deleted,
      lastPruneAt: new Date(result.lastPruneAt).toISOString(),
    },
    pretty: ctx => {
      writeLine(`Pruned ${result.deleted} stale observation rows.`);
      writeLine(`${dim(ctx, 'at:')} ${new Date(result.lastPruneAt).toISOString()}`);
    },
  };
};

export function pruneMemory(flags: GlobalFlags): Promise<never> {
  return runCommand('memory.prune', flags, pruneCmd);
}
