/**
 * Attachment converters: PDF → PNGs, DOCX → PDF, XLSX/XLS → CSV.
 *
 * These shell out to `pdftoppm` (poppler) and `libreoffice` (headless mode).
 * Both binaries are optional — the consuming code is expected to first call
 * `detectConverters()` and gracefully skip conversions for the missing ones,
 * surfacing an install hint to the user.
 *
 * Every binary name, probe arg, and install hint lives in `constants/` so
 * a fork can swap implementations without touching this file.
 */

import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { platform } from 'node:os';
import { promisify } from 'node:util';

import { CONVERTER_BIN, CONVERTER_PROBE_ARGS, CONVERTER_INSTALL_HINTS } from '../constants';

const execFileAsync = promisify(execFile);

export interface ConverterAvailability {
  pdftoppm: boolean;
  libreoffice: boolean;
}

async function hasBin(bin: string, args: readonly string[]): Promise<boolean> {
  try {
    await execFileAsync(bin, [...args]);
    return true;
  } catch {
    return false;
  }
}

export async function detectConverters(): Promise<ConverterAvailability> {
  const [pdftoppm, libreoffice] = await Promise.all([
    hasBin(CONVERTER_BIN.PDFTOPPM, CONVERTER_PROBE_ARGS.PDFTOPPM),
    hasBin(CONVERTER_BIN.LIBREOFFICE, CONVERTER_PROBE_ARGS.LIBREOFFICE),
  ]);
  return { pdftoppm, libreoffice };
}

function platformKey(): 'darwin' | 'linux' {
  return platform() === 'darwin' ? 'darwin' : 'linux';
}

export function pdftoppmInstallHint(): string {
  return CONVERTER_INSTALL_HINTS.PDFTOPPM[platformKey()];
}

export function libreofficeInstallHint(): string {
  return CONVERTER_INSTALL_HINTS.LIBREOFFICE[platformKey()];
}

/** Convert a PDF to per-page PNGs. Returns the generated paths sorted by page. */
export async function pdfToPngs(pdfPath: string, outDir: string): Promise<string[]> {
  const stem = basename(pdfPath, extname(pdfPath));
  const prefix = join(outDir, stem);
  await execFileAsync(CONVERTER_BIN.PDFTOPPM, ['-png', pdfPath, prefix]);
  return readdirSync(outDir)
    .filter(f => f.startsWith(`${stem}-`) && f.endsWith('.png'))
    .sort()
    .map(f => join(outDir, f));
}

/** Convert a DOCX (or compatible doc) to PDF via LibreOffice. */
export async function docxToPdf(docxPath: string, outDir: string): Promise<string> {
  await execFileAsync(CONVERTER_BIN.LIBREOFFICE, [
    '--headless',
    '--convert-to',
    'pdf',
    '--outdir',
    outDir,
    docxPath,
  ]);
  const stem = basename(docxPath, extname(docxPath));
  return join(outDir, `${stem}.pdf`);
}

/** Convert an Excel file to CSV via LibreOffice. */
export async function excelToCsv(xlsPath: string, outDir: string): Promise<string> {
  await execFileAsync(CONVERTER_BIN.LIBREOFFICE, [
    '--headless',
    '--convert-to',
    'csv',
    '--outdir',
    outDir,
    xlsPath,
  ]);
  const stem = basename(xlsPath, extname(xlsPath));
  return join(outDir, `${stem}.csv`);
}
