/**
 * `lwr issue attach <id> <file>...`
 *
 * Upload one or more files as attachments on an existing issue. The
 * command performs the Redmine two-step:
 *   1) POST /uploads.json per file → upload token
 *   2) Single PUT /issues/<id>.json bundling all tokens (+ optional note)
 *
 * Bundling keeps Redmine from emitting multiple journal entries — agents
 * see one update, not N.
 *
 * Notes for agents (relevant in JSON mode):
 *   - data.uploaded: [{filename, sizeBytes, token, attachmentId, contentType}]
 *   - data.issueId, data.note (when --message was used)
 */

import fs from 'node:fs';
import path from 'node:path';
import { runCommand, type CommandFn, type CommandResult, type GlobalFlags, dryRunPreview, type DryRunPreview } from '../../foundation/run';
import { openSession } from '../../foundation/session';
import { uploadFile, attachToIssue } from '../../api/issues';
import { writeLine } from '../../foundation/output';
import { success, dim } from '../../foundation/format';
import { ValidationError } from '../../foundation/errors';
import { safeAttachmentBasename } from '../../foundation/attachments';
import { ERROR_CODES, REDMINE_PATHS } from '../../constants';
import type { RedmineAttachment } from '../../api/types';

export interface IssueAttachFlags extends GlobalFlags {
  id?: string | number;
  files?: string[];
  description?: string;
  message?: string;
  messageFile?: string;
  private?: boolean;
  /** Override the displayed filename. Only valid with a single file. */
  filenameAs?: string;
  /** Override content type. Applies to all uploads. */
  contentType?: string;
}

interface UploadedRow {
  filename: string;
  localPath: string;
  sizeBytes: number;
  token: string;
  contentType?: string;
  /** Set after the issue update lands and we re-fetch the issue. */
  attachmentId?: number;
}

interface Payload {
  issueId: number;
  uploaded: UploadedRow[];
  note: string | null;
}

const cmd: CommandFn<Payload | DryRunPreview> = async (flags): Promise<CommandResult<Payload | DryRunPreview>> => {
  const f = flags as IssueAttachFlags;
  if (f.id === undefined || f.id === null || f.id === '') {
    throw new ValidationError(
      'Issue id is required.',
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      'Pass it as `lwr issue attach <id> <file>...`.',
    );
  }
  const id = normaliseId(f.id);

  const files = f.files ?? [];
  if (files.length === 0) {
    throw new ValidationError(
      'At least one file path is required.',
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      'Pass file paths after the issue id, e.g. `lwr issue attach 64602 ./screenshot.png`.',
    );
  }
  if (f.filenameAs && files.length > 1) {
    throw new ValidationError(
      '--filename-as can only be used with a single file.',
      ERROR_CODES.VALIDATION_BAD_VALUE,
    );
  }

  // Resolve note text. Mirrors the `issue note` flag shape.
  let noteText: string | null = null;
  if (f.message !== undefined) noteText = f.message;
  else if (f.messageFile !== undefined) {
    noteText = f.messageFile === '-'
      ? fs.readFileSync(0, 'utf8')
      : fs.readFileSync(f.messageFile, 'utf8');
  }
  if (noteText !== null && noteText.trim().length === 0) noteText = null;

  // Validate every file exists *before* hitting the network. Cheap and
  // makes the error surface clean for agents.
  const fileMeta = files.map(p => {
    if (!fs.existsSync(p)) {
      throw new ValidationError(
        `File not found: ${p}`,
        ERROR_CODES.VALIDATION_BAD_VALUE,
      );
    }
    const st = fs.statSync(p);
    if (!st.isFile()) {
      throw new ValidationError(
        `Not a regular file: ${p}`,
        ERROR_CODES.VALIDATION_BAD_VALUE,
      );
    }
    return {
      localPath: p,
      sizeBytes: st.size,
      filename: safeAttachmentBasename(f.filenameAs ?? path.basename(p)),
    };
  });

  // --dry-run: don't even open a session — file validation already ran,
  // and uploads are themselves a side effect (Redmine creates upload
  // records with a TTL). Show what would be attached without sending
  // any bytes.
  if (flags.dryRun) {
    const path1 = REDMINE_PATHS.UPLOADS;
    const path2 = REDMINE_PATHS.ISSUE_BY_ID(id);
    const preview = dryRunPreview({
      method: 'POST',
      path: path1,
      payload: null,
      resolved: {
        issueId: id,
        files: fileMeta.map(m => ({ filename: m.filename, localPath: m.localPath, sizeBytes: m.sizeBytes })),
        ...(noteText !== null ? { note: { length: noteText.length, private: Boolean(f.private) } } : {}),
        twoStepFollowUp: { method: 'PUT', path: path2, body: 'issue.uploads = [{ token, filename, ... }]' },
      },
    });
    return {
      json: preview,
      pretty: ctx => {
        writeLine(dim(ctx, `[dry-run] would upload ${fileMeta.length} file(s) then PUT ${path2}`));
        for (const m of fileMeta) writeLine(dim(ctx, `  ${m.filename}  (${formatBytes(m.sizeBytes)})`));
      },
    };
  }

  const session = await openSession(flags);

  // Step 1 — upload bytes per file (sequential; Redmine handles concurrent
  // uploads but agents care about a deterministic order and clear errors).
  const uploaded: UploadedRow[] = [];
  for (const meta of fileMeta) {
    const bytes = fs.readFileSync(meta.localPath);
    const token = await uploadFile(session.client, bytes, meta.filename);
    uploaded.push({
      filename: meta.filename,
      localPath: meta.localPath,
      sizeBytes: meta.sizeBytes,
      token,
      contentType: f.contentType,
    });
  }

  // Step 2 — bundle all tokens into a single issue update.
  const issue = await attachToIssue(
    session.client,
    id,
    uploaded.map(u => ({
      token: u.token,
      filename: u.filename,
      description: f.description,
      contentType: f.contentType,
    })),
    noteText !== null ? { text: noteText, privateNotes: f.private } : undefined,
  );

  // Best-effort attachment-id reverse lookup so agents can deep-link.
  // Match by filename + size — Redmine doesn't echo the upload token back.
  const attachments: RedmineAttachment[] = issue.attachments ?? [];
  for (const row of uploaded) {
    const match = attachments.find(a => a.filename === row.filename && a.filesize === row.sizeBytes);
    if (match) row.attachmentId = match.id;
  }

  return {
    json: { issueId: issue.id, uploaded, note: noteText },
    pretty: ctx => {
      writeLine(success(ctx, `Attached ${uploaded.length} file${uploaded.length === 1 ? '' : 's'} to #${issue.id}`));
      for (const u of uploaded) {
        const idPart = u.attachmentId ? `#${u.attachmentId}` : dim(ctx, '(id pending)');
        writeLine(`  ${idPart}  ${u.filename}  ${dim(ctx, formatBytes(u.sizeBytes))}`);
      }
      if (noteText) writeLine(dim(ctx, `  + note (${noteText.length} chars)`));
    },
  };
};

function normaliseId(input: string | number): number {
  const s = String(input).trim().replace(/^#/, '');
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ValidationError(
      `Invalid issue id: ${input}`,
      ERROR_CODES.VALIDATION_BAD_VALUE,
    );
  }
  return n;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function attach(flags: IssueAttachFlags): Promise<never> {
  return runCommand('issue.attach', flags, cmd);
}
