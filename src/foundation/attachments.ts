/**
 * Issue-attachment download orchestration.
 *
 * Given an issue's `attachments[]`, this module:
 *   1. Downloads each file into the issue's per-id directory (skipping any
 *      already-present files unless `force` is set — the directory doubles
 *      as a permanent cache).
 *   2. Optionally derives "agent-friendly" representations:
 *        PDF   → page-by-page PNGs (via pdftoppm)
 *        DOCX  → PDF → PNGs       (via libreoffice + pdftoppm)
 *        XLSX  → CSV              (via libreoffice)
 *   3. Returns a structured manifest the caller can persist or inline into
 *      the JSON envelope.
 *
 * Missing converter binaries are non-fatal: we keep the original file as the
 * sole "derivative" and emit a single warning per converter so the user sees
 * the install hint exactly once per fetch.
 */

import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import path, { join } from 'node:path';
import type { Readable } from 'node:stream';

import { logger } from './logger';
import { http, type RedmineClient } from './client';
import {
  detectConverters,
  docxToPdf,
  excelToCsv,
  libreofficeInstallHint,
  pdfToPngs,
  pdftoppmInstallHint,
  type ConverterAvailability,
} from './converters';
import { ValidationError } from './errors';
import { ERROR_CODES } from '../constants';
import type { RedmineAttachment } from '../api/types';

/**
 * Strip directory components from a filename that may have come from an
 * untrusted source (Redmine response or user --filename-as flag). Reject
 * empty / `.` / `..` / NUL-bearing names so a malicious server can't write
 * outside the chosen output directory.
 *
 * Defends across platforms by stripping both POSIX `/` and Windows `\`
 * separators, regardless of the host OS, since Redmine echoes raw strings.
 */
export function safeAttachmentBasename(name: string): string {
  const base = path.posix.basename(path.win32.basename(name));
  if (base === '' || base === '.' || base === '..' || /[\x00-\x1f]/.test(base)) {
    throw new ValidationError(
      `Refusing attachment with unsafe filename: ${JSON.stringify(name)}`,
      ERROR_CODES.VALIDATION_BAD_VALUE,
      'Filename must be a single path component (no `/`, `\\`, or `..`).',
    );
  }
  return base;
}

export type ConversionKind = 'pdf-pages' | 'docx-pages' | 'excel-csv' | 'none';

export interface AttachmentEntry {
  id: number;
  filename: string;
  contentType: string;
  size: number;
  /** Path of the originally downloaded file. */
  originalPath: string;
  /**
   * Files the caller should consume. For converted assets these are the
   * derived files (e.g. PNG pages); otherwise it's just `[originalPath]`.
   */
  derivatives: string[];
  conversion: ConversionKind;
  /** True when the original file was already on disk and we skipped HTTP. */
  fromCache: boolean;
}

export interface AttachmentManifest {
  dir: string;
  entries: AttachmentEntry[];
}

export interface DownloadOptions {
  client: RedmineClient;
  attachments: RedmineAttachment[];
  /** Absolute path to write into. Caller is responsible for picking it. */
  outDir: string;
  /** Re-download even if the original exists. Default false. */
  force?: boolean;
  /** When false, skip all conversions and just download originals. Default true. */
  convert?: boolean;
}

export async function downloadIssueAttachments(
  opts: DownloadOptions,
): Promise<AttachmentManifest> {
  const { client, attachments, outDir, force = false, convert = true } = opts;

  mkdirSync(outDir, { recursive: true });

  if (attachments.length === 0) {
    return { dir: outDir, entries: [] };
  }

  const availability = convert ? await detectConverters() : { pdftoppm: false, libreoffice: false };
  warnOnMissingConverters(attachments, availability, convert);

  const entries = await Promise.all(
    attachments.map(att => processOne(client, att, outDir, availability, force, convert)),
  );

  return { dir: outDir, entries };
}

/** Build a `filename → derivatives[]` map for description rewriting. */
export function manifestToFileMap(manifest: AttachmentManifest): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const e of manifest.entries) {
    map.set(e.filename, e.derivatives);
    map.set(encodeURIComponent(e.filename), e.derivatives);
  }
  return map;
}

// ---------------------------------------------------------------------------

async function processOne(
  client: RedmineClient,
  att: RedmineAttachment,
  outDir: string,
  availability: ConverterAvailability,
  force: boolean,
  convert: boolean,
): Promise<AttachmentEntry> {
  const safeName = safeAttachmentBasename(att.filename);
  const originalPath = join(outDir, safeName);

  let fromCache = false;
  if (existsSync(originalPath) && !force && statSync(originalPath).size > 0) {
    fromCache = true;
    logger.debug(`cached: ${safeName}`);
  } else {
    await downloadOne(client, att.content_url, originalPath);
    logger.debug(`downloaded: ${safeName}`);
  }

  const conversion = convert ? pickConversion(att, availability) : 'none';
  const derivatives = await runConversion(originalPath, outDir, conversion);

  return {
    id: att.id,
    filename: att.filename,
    contentType: att.content_type,
    size: att.filesize,
    originalPath,
    derivatives,
    conversion,
    fromCache,
  };
}

async function downloadOne(client: RedmineClient, url: string, dest: string): Promise<void> {
  await http(async () => {
    const res = await client.get<Readable>(url, { responseType: 'stream' });
    await new Promise<void>((resolve, reject) => {
      const ws = createWriteStream(dest);
      res.data.pipe(ws);
      ws.on('finish', () => resolve());
      ws.on('error', reject);
      res.data.on('error', reject);
    });
  });
}

function pickConversion(att: RedmineAttachment, av: ConverterAvailability): ConversionKind {
  const name = att.filename.toLowerCase();
  const isPdf = att.content_type === 'application/pdf' || name.endsWith('.pdf');
  if (isPdf && av.pdftoppm) return 'pdf-pages';
  if (name.endsWith('.docx') && av.libreoffice && av.pdftoppm) return 'docx-pages';
  if (/\.(xlsx|xls)$/i.test(name) && av.libreoffice) return 'excel-csv';
  return 'none';
}

async function runConversion(
  originalPath: string,
  outDir: string,
  kind: ConversionKind,
): Promise<string[]> {
  switch (kind) {
    case 'pdf-pages':
      return pdfToPngs(originalPath, outDir);
    case 'docx-pages': {
      const pdfPath = await docxToPdf(originalPath, outDir);
      return pdfToPngs(pdfPath, outDir);
    }
    case 'excel-csv':
      return [await excelToCsv(originalPath, outDir)];
    case 'none':
      return [originalPath];
  }
}

function warnOnMissingConverters(
  attachments: RedmineAttachment[],
  av: ConverterAvailability,
  convert: boolean,
): void {
  if (!convert) return;

  const hasPdf = attachments.some(
    a => a.content_type === 'application/pdf' || a.filename.toLowerCase().endsWith('.pdf'),
  );
  const hasDocx = attachments.some(a => a.filename.toLowerCase().endsWith('.docx'));
  const hasExcel = attachments.some(a => /\.(xlsx|xls)$/i.test(a.filename));

  if (hasPdf && !av.pdftoppm) {
    logger.warn(
      `pdftoppm not found — PDF attachments won't be split into PNGs. Install with: ${pdftoppmInstallHint()}`,
    );
  }
  if (hasDocx && !av.libreoffice) {
    logger.warn(
      `libreoffice not found — DOCX won't be converted. Install with: ${libreofficeInstallHint()}`,
    );
  }
  if (hasDocx && av.libreoffice && !av.pdftoppm) {
    logger.warn(
      `pdftoppm not found — DOCX will convert to PDF only (no PNG split). Install with: ${pdftoppmInstallHint()}`,
    );
  }
  if (hasExcel && !av.libreoffice) {
    logger.warn(
      `libreoffice not found — Excel attachments won't be converted to CSV. Install with: ${libreofficeInstallHint()}`,
    );
  }
}
