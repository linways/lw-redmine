/**
 * `lwr issue fetch <id>`
 *
 * Materialise an issue and its attachments to a stable on-disk location:
 *
 *     ~/.lwr/issues/<id>/
 *       ├── issue.json       # raw API payload (source of truth)
 *       ├── issue.md         # rendered Markdown — description rewrites
 *       │                      attachment refs (e.g. ![](foo.pdf)) into the
 *       │                      derived per-page PNGs so AI agents can read
 *       │                      visual content without OCR
 *       ├── manifest.json    # download/conversion summary
 *       └── <attachments>    # originals + derivatives (pdf-pages, csv, …)
 *
 * Flags:
 *   --force          Re-download attachments (default: skip if cached)
 *   --no-convert     Skip PDF/DOCX/XLSX conversions (keep originals only)
 *   --out <dir>      Override target directory (default: ~/.lwr/issues/<id>/)
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { ERROR_CODES } from '../../constants';
import { ISSUE_FILE } from '../../constants';
import { ValidationError } from '../../foundation/errors';
import { writeLine } from '../../foundation/output';
import { issuesDir } from '../../foundation/paths';
import { runCommand, type CommandFn, type CommandResult, type GlobalFlags } from '../../foundation/run';
import { openSession } from '../../foundation/session';
import { dim, header, success } from '../../foundation/format';
import {
  downloadIssueAttachments,
  manifestToFileMap,
  type AttachmentManifest,
} from '../../foundation/attachments';
import { getIssue } from '../../api/issues';
import type { RedmineIssue } from '../../api/types';

export interface IssueFetchFlags extends GlobalFlags {
  id?: string | number;
  /** Re-download attachments even if cached. */
  force?: boolean;
  /** Skip conversions (PDF→PNG, DOCX→PDF→PNG, XLSX→CSV). */
  convert?: boolean;
  /** Override target directory. */
  out?: string;
}

interface FetchPayload {
  id: number;
  dir: string;
  files: {
    issueJson: string;
    issueMarkdown: string;
    manifest: string;
  };
  attachments: AttachmentManifest['entries'];
  counts: {
    attachments: number;
    downloaded: number;
    cached: number;
    converted: number;
  };
}

const cmd: CommandFn<FetchPayload> = async (flags): Promise<CommandResult<FetchPayload>> => {
  const flgs = flags as IssueFetchFlags;
  if (flgs.id === undefined || flgs.id === null || flgs.id === '') {
    throw new ValidationError(
      'Issue id is required.',
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      'Pass it as `lwr issue fetch <id>`.',
    );
  }
  const id = normaliseId(flgs.id);

  const session = await openSession(flags);
  const issue = await getIssue(session.client, id, { detail: true });

  const outDir = flgs.out ?? issuesDir(id);
  mkdirSync(outDir, { recursive: true });

  // Persist raw payload first — it's the source of truth other tools rely on.
  const issueJsonPath = join(outDir, ISSUE_FILE.RAW_JSON);
  writeFileSync(issueJsonPath, JSON.stringify(issue, null, 2), 'utf8');

  const manifest = await downloadIssueAttachments({
    client: session.client,
    attachments: issue.attachments ?? [],
    outDir,
    force: Boolean(flgs.force),
    convert: flgs.convert !== false,
  });

  const fileMap = manifestToFileMap(manifest);
  const issueMdPath = join(outDir, ISSUE_FILE.MARKDOWN);
  writeFileSync(issueMdPath, renderIssueMarkdown(issue, fileMap, outDir), 'utf8');

  const manifestPath = join(outDir, ISSUE_FILE.MANIFEST);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  const counts = {
    attachments: manifest.entries.length,
    downloaded: manifest.entries.filter(e => !e.fromCache).length,
    cached: manifest.entries.filter(e => e.fromCache).length,
    converted: manifest.entries.filter(e => e.conversion !== 'none').length,
  };

  return {
    json: {
      id,
      dir: outDir,
      files: { issueJson: issueJsonPath, issueMarkdown: issueMdPath, manifest: manifestPath },
      attachments: manifest.entries,
      counts,
    },
    pretty: ctx => {
      writeLine(success(ctx, `Fetched #${id} → ${outDir}`));
      writeLine(`  ${dim(ctx, 'subject :')} ${issue.subject}`);
      writeLine(`  ${dim(ctx, 'status  :')} ${issue.status.name}`);
      writeLine(`  ${dim(ctx, 'files   :')} issue.json, issue.md, manifest.json`);
      if (counts.attachments > 0) {
        writeLine('');
        writeLine(header(ctx, `Attachments (${counts.attachments})`));
        writeLine(
          `  ${dim(ctx, 'downloaded:')} ${counts.downloaded}    ${dim(ctx, 'cached:')} ${counts.cached}    ${dim(ctx, 'converted:')} ${counts.converted}`,
        );
        for (const e of manifest.entries) {
          const tag = e.conversion === 'none' ? '' : dim(ctx, ` [${e.conversion}]`);
          writeLine(`  · ${e.filename}${tag}`);
          if (e.derivatives.length > 1 || e.derivatives[0] !== e.originalPath) {
            for (const d of e.derivatives) {
              writeLine(`      ${dim(ctx, '→')} ${relative(outDir, d)}`);
            }
          }
        }
      }
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
      'Issue ids are positive integers, optionally prefixed with `#`.',
    );
  }
  return n;
}

/**
 * Render an issue to Markdown with attachment refs rewritten to local paths.
 *
 * For PDFs/DOCX, a single `![alt](file.pdf)` becomes one `![alt](page-N.png)`
 * line per page so an LLM reader can ingest each page as an image without
 * needing to find the original.
 */
function renderIssueMarkdown(
  issue: RedmineIssue,
  fileMap: Map<string, string[]>,
  outDir: string,
): string {
  const lines: string[] = [];

  lines.push(`# #${issue.id} — ${issue.subject}`);
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('|---|---|');
  lines.push(`| Project | ${issue.project.name} |`);
  lines.push(`| Tracker | ${issue.tracker.name} |`);
  lines.push(`| Status | ${issue.status.name} |`);
  lines.push(`| Priority | ${issue.priority.name} |`);
  lines.push(`| Author | ${issue.author.name} |`);
  if (issue.assigned_to) lines.push(`| Assignee | ${issue.assigned_to.name} |`);
  if (issue.fixed_version) lines.push(`| Version | ${issue.fixed_version.name} |`);
  if (issue.due_date) lines.push(`| Due | ${issue.due_date} |`);
  if (issue.estimated_hours != null) lines.push(`| Est. hours | ${issue.estimated_hours} |`);
  if (issue.spent_hours != null) lines.push(`| Spent hours | ${issue.spent_hours} |`);
  lines.push(`| Done | ${issue.done_ratio ?? 0}% |`);
  lines.push(`| Created | ${issue.created_on} |`);
  lines.push(`| Updated | ${issue.updated_on} |`);
  lines.push('');

  if (issue.description && issue.description.trim().length > 0) {
    lines.push('## Description');
    lines.push('');
    lines.push(rewriteImageRefs(issue.description, fileMap, outDir));
    lines.push('');
  }

  if (issue.journals && issue.journals.length > 0) {
    lines.push(`## Journal (${issue.journals.length})`);
    lines.push('');
    for (const j of issue.journals) {
      lines.push(`### ${j.user.name} — ${j.created_on}`);
      if (j.details && j.details.length > 0) {
        for (const d of j.details) {
          lines.push(`- *${d.property}.${d.name}*: ${d.old_value ?? '—'} → ${d.new_value ?? '—'}`);
        }
      }
      if (j.notes && j.notes.trim().length > 0) {
        lines.push('');
        lines.push(rewriteImageRefs(j.notes, fileMap, outDir));
      }
      lines.push('');
    }
  }

  if (issue.attachments && issue.attachments.length > 0) {
    lines.push(`## Attachments (${issue.attachments.length})`);
    lines.push('');
    for (const att of issue.attachments) {
      const paths = fileMap.get(att.filename) ?? [];
      lines.push(`- **${att.filename}** (${att.filesize} bytes, ${att.content_type})`);
      for (const p of paths) lines.push(`    - \`${relative(outDir, p)}\``);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Replace `![alt](file.ext)` with one `![alt](local-path)` per derivative.
 * Falls back to the original markdown if no mapping exists.
 */
function rewriteImageRefs(
  text: string,
  fileMap: Map<string, string[]>,
  outDir: string,
): string {
  if (fileMap.size === 0) return text;
  return text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt: string, src: string) => {
    const decoded = decodeURIComponent(src);
    const paths = fileMap.get(decoded) ?? fileMap.get(src);
    if (!paths || paths.length === 0) return match;
    return paths.map(p => `![${alt}](${relative(outDir, p)})`).join('\n');
  });
}

export function fetch(flags: IssueFetchFlags): Promise<never> {
  return runCommand('issue.fetch', flags, cmd);
}
