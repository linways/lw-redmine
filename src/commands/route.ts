/**
 * EXPERIMENTAL — `lwr route <text...>`
 *
 * Ask TypeSafe's Jev model which lwr command fulfils a natural-language
 * request. One HTTP call carries two questions:
 *   - command              (choice over every leaf command, criteria = description)
 *   - needs_clarification  (noul: is user input missing, e.g. "update my issue")
 *
 * Suggest-only: route never executes anything. `action` tells the caller
 * what to do with the answer:
 *   ask      → needs_clarification ≥ ROUTE_CLARIFY; ask the user first
 *   run      → confidence ≥ ROUTE_CONFIDENT
 *   confirm  → anything else; show `alternatives` and let the caller pick
 *
 * Jev can only choose/score, not extract free values, so issue ids and
 * durations are pulled from the text with regexes as `hints`.
 */

import type { Command } from 'commander';
import { runCommand, type CommandFn, type GlobalFlags } from '../foundation/run';
import { buildPayload, type SerializedCommand } from './commands';
import { writeLine } from '../foundation/output';
import { dim, success } from '../foundation/format';
import { LwrError, NetworkError, ValidationError } from '../foundation/errors';
import {
  ERROR_CODES,
  EXIT,
  JEV_API_KEY_ENV,
  JEV_DESCRIPTION_MAX,
  JEV_ENDPOINT,
  JEV_MODEL,
  JEV_TIMEOUT_MS,
  ROUTE_CLARIFY,
  ROUTE_CONFIDENT,
  ROUTE_CONTEXT,
} from '../constants';

export interface RouteFlags extends GlobalFlags {
  text?: string[];
}

export interface RoutePayload {
  request: string;
  action: 'run' | 'confirm' | 'ask';
  command: string;
  /** e.g. `lwr issue status <id> <status>` */
  usage: string;
  confidence: number;
  /** Probability the request is missing user-supplied info. */
  needsClarification: number;
  alternatives: { command: string; probability: number }[];
  hints: { issueIds: number[]; spent: string | null };
  model: string;
  latencyMs: number;
}

interface JevResponse {
  model: string;
  answers: {
    command: { choice: string; confidence: number; probabilities: Record<string, number> };
    needs_clarification: { noul: number };
  };
}

export function routeCmd(program: Command) {
  return (flags: RouteFlags): Promise<never> => {
    const cmd: CommandFn<RoutePayload> = async () => {
      const request = (flags.text ?? []).join(' ').trim();
      if (request.length === 0) {
        throw new ValidationError(
          'Request text is required.',
          ERROR_CODES.VALIDATION_MISSING_FLAG,
          'e.g. `lwr route "mark 132188 dev completed and log 1h"`.',
        );
      }
      const key = process.env[JEV_API_KEY_ENV];
      if (!key) {
        throw new LwrError({
          message: `lwr route is experimental and needs a TypeSafe Jev API key in $${JEV_API_KEY_ENV}.`,
          code: ERROR_CODES.JEV_KEY_MISSING,
          exit: EXIT.CONFIG,
          hint: `Get a key at https://console.typesafe.ai/keys, then \`export ${JEV_API_KEY_ENV}=...\`. Not an lwr auth problem — do not run \`lwr auth login\`.`,
        });
      }

      const catalog = buildPayload(program).commands.filter(c => c.name !== 'route');
      const t0 = Date.now();
      const res = await askJev(key, request, catalog);
      const latencyMs = Date.now() - t0;

      const { command, needs_clarification } = res.answers;
      const chosen = catalog.find(c => c.name === command.choice);
      if (!chosen) {
        throw new LwrError({
          message: `Jev chose an unknown command "${command.choice}".`,
          code: ERROR_CODES.JEV_REQUEST_FAILED,
          exit: EXIT.SERVER,
        });
      }
      const needsClarification = needs_clarification.noul;
      const action: RoutePayload['action'] =
        needsClarification >= ROUTE_CLARIFY ? 'ask' : command.confidence >= ROUTE_CONFIDENT ? 'run' : 'confirm';

      const payload: RoutePayload = {
        request,
        action,
        command: chosen.name,
        usage: usageOf(chosen),
        confidence: round2(command.confidence),
        needsClarification: round2(needsClarification),
        alternatives: Object.entries(command.probabilities)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([c, p]) => ({ command: c, probability: round2(p) })),
        hints: extractHints(request),
        model: res.model,
        latencyMs,
      };
      return {
        json: payload,
        pretty: ctx => {
          writeLine(success(ctx, `${payload.action.toUpperCase()}  ${payload.usage}`));
          writeLine(dim(ctx, `  confidence ${payload.confidence} · needs clarification ${payload.needsClarification} · ${payload.model} · ${latencyMs}ms`));
          writeLine(dim(ctx, `  alternatives: ${payload.alternatives.map(a => `${a.command} ${a.probability}`).join(', ')}`));
          if (payload.hints.issueIds.length > 0 || payload.hints.spent) {
            writeLine(dim(ctx, `  hints: ids=${payload.hints.issueIds.join(',') || '-'} spent=${payload.hints.spent ?? '-'}`));
          }
        },
      };
    };
    return runCommand('route', flags, cmd);
  };
}

async function askJev(key: string, request: string, catalog: SerializedCommand[]): Promise<JevResponse> {
  const body = {
    model: JEV_MODEL,
    state: { request, context: ROUTE_CONTEXT },
    questions: {
      command: {
        type: 'choice',
        instructions: 'Which lwr CLI command best fulfils `request`?',
        criteria: Object.fromEntries(catalog.map(c => [c.name, c.description.slice(0, JEV_DESCRIPTION_MAX)])),
      },
      needs_clarification: {
        type: 'noul',
        instructions:
          '`request` is missing information the user must supply before it can be carried out ' +
          '(e.g. it says to update or change an issue but never says which issue or what to change). ' +
          'Pure questions and lookups are not missing anything.',
      },
    },
  };

  let res: Response;
  try {
    res = await fetch(JEV_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError';
    throw new NetworkError(
      timedOut ? `Jev did not answer within ${JEV_TIMEOUT_MS}ms.` : `Could not reach Jev: ${err instanceof Error ? err.message : String(err)}`,
      timedOut ? ERROR_CODES.NETWORK_TIMEOUT : ERROR_CODES.NETWORK_REFUSED,
      undefined,
      err,
    );
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 300);
    throw new LwrError({
      message: `Jev returned HTTP ${res.status}${text ? `: ${text}` : ''}`,
      code: ERROR_CODES.JEV_REQUEST_FAILED,
      exit: res.status >= 500 ? EXIT.SERVER : EXIT.CONFIG,
      hint: res.status === 401 || res.status === 403 ? `Check the key in $${JEV_API_KEY_ENV}.` : undefined,
      details: { status: res.status },
    });
  }
  const json = (await res.json()) as Partial<JevResponse>;
  if (!json.answers?.command || !json.answers.needs_clarification) {
    throw new LwrError({
      message: 'Jev response is missing expected answers.',
      code: ERROR_CODES.JEV_REQUEST_FAILED,
      exit: EXIT.SERVER,
    });
  }
  return json as JevResponse;
}

function usageOf(c: SerializedCommand): string {
  const args = c.args.map(a => (a.required ? `<${a.name}${a.variadic ? '...' : ''}>` : `[${a.name}]`));
  return ['lwr', ...c.path, ...args].join(' ');
}

/** Issue ids (#123 or 4-7 digit numbers) and the first duration ("1h", "30 min", "1.5 hours"). */
export function extractHints(text: string): RoutePayload['hints'] {
  const issueIds = [...new Set([...text.matchAll(/#?\b(\d{4,7})\b(?!\s*(?:h|hr|hrs|hours?|m|min|mins|minutes?)\b)/gi)].map(m => Number(m[1])))];
  const d = /(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|m|min|mins|minutes?)\b/i.exec(text);
  const spent = d ? `${d[1]}${d[2].toLowerCase().startsWith('h') ? 'h' : 'm'}` : null;
  return { issueIds, spent };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
