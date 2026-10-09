// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and the JSON result renderer.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import { logOf, type CliDeps } from "./io.js";
import { cleartextProblem, DEFAULT_BASE_URL, headerValueProblem, isBidiControl, type EngineOptions } from "../client/engine.js";
import { baseUrlProblem, idProblem, roadIdProblem } from "../client/validate.js";

/**
 * commander value-parser: a plain non-negative decimal integer.
 *
 * Only `^\d+$` is accepted — this deliberately rejects the empty string,
 * surrounding whitespace, hex (`0x10`), binary (`0b1`), and exponent forms
 * (`1e3`), all of which `Number()` would otherwise coerce silently.
 */
export function parseIntArg(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    // It is a non-negative integer, just too large to hold exactly: name the limit.
    throw new InvalidArgumentError(`Expected an integer from 0 to ${Number.MAX_SAFE_INTEGER}.`);
  }
  return n;
}

/** Build a commander value-parser for an integer constrained to [min, max]. */
export function parseBoundedInt(min: number, max: number): (value: string) => number {
  return (value: string) => {
    if (!/^\d+$/.test(value)) throw new InvalidArgumentError("Expected a non-negative integer.");
    // A digit string too large to hold exactly is out of range too: name the range.
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < min || n > max) {
      throw new InvalidArgumentError(`Expected an integer from ${min} to ${max}.`);
    }
    return n;
  };
}

/**
 * commander value-parser for a value that ends up in an HTTP header (`--user-agent`).
 * Node's HTTP layer throws an opaque "Invalid character in header content" at request
 * time for a CR/LF (or any other C0 control or DEL) and for any character above
 * U+00FF, which surfaced as "Unexpected error". Reject those here as a usage error,
 * along with a blank value (which used to fall back to the default silently, or send
 * an empty header). The rule is the engine's `headerValueProblem`.
 */
export function parseHeaderValue(value: string): string {
  const problem = headerValueProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return value;
}

/**
 * commander value-parser for --base-url: the library's `baseUrlProblem` rule (http(s)
 * only, no query or fragment, no surrounding whitespace or control characters), as a
 * usage error before any request. The engine enforces the same rule for library callers.
 */
export function parseBaseUrl(value: string): string {
  const problem = baseUrlProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return value;
}

/**
 * commander value-parser for a road id or identifier argument: the library's
 * `idProblem` rule (non-blank, no "/", not "." or ".."), as a usage error before any
 * request. The client enforces the same rule for library callers.
 */
export function parseId(value: string): string {
  const problem = idProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return value;
}

/** commander value-parser for a `<roadId>` argument: the library's `roadIdProblem` rule. */
export function parseRoadId(value: string): string {
  const problem = roadIdProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return value;
}

export interface GlobalOptions {
  baseUrl?: string;
  timeout?: number;
  userAgent?: string;
  maxRetries?: number;
  maxResponseBytes?: number;
  compact?: boolean;
}

/** Translate resolved global CLI options into client EngineOptions. */
export function toEngineOptions(global: GlobalOptions): EngineOptions {
  const options: EngineOptions = {};
  if (global.baseUrl !== undefined) options.baseUrl = global.baseUrl;
  if (global.timeout !== undefined) options.timeoutMs = global.timeout;
  if (global.userAgent !== undefined) options.userAgent = global.userAgent;
  if (global.maxRetries !== undefined) options.maxRetries = global.maxRetries;
  if (global.maxResponseBytes !== undefined) options.maxResponseBytes = global.maxResponseBytes;
  return options;
}

/**
 * Escape the characters JSON.stringify leaves raw although a terminal acts on them.
 * It escapes C0 (including ESC) but not DEL, the C1 range U+0080–U+009F (U+009B is
 * the 8-bit form of CSI) or the bidi formatting characters (isBidiControl), which
 * reorder the text that follows. The output is server data, so escape them; the
 * result is equivalent, valid JSON (these characters only occur inside strings).
 * Checked by char code so the source stays free of control bytes.
 */
export function escapeControlChars(json: string): string {
  let result = "";
  let from = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if ((c >= 0x7f && c <= 0x9f) || isBidiControl(c)) {
      result += json.slice(from, i) + "\\u" + c.toString(16).padStart(4, "0");
      from = i + 1;
    }
  }
  return from === 0 ? json : result + json.slice(from);
}

/** Render a JSON value to stdout, pretty by default, compact with --compact. */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = escapeControlChars(global.compact ? JSON.stringify(value) : JSON.stringify(value, null, 2));
  deps.io.out(text);
}

/**
 * Log one warning (a WARN record of `autobahn.http`) when the effective base URL (--base-url >
 * AUTOBAHN_BASE_URL > default) is plain `http:` to a host other than loopback
 * (cleartextProblem): requests, and any user:password@ in the URL, travel unencrypted.
 * Called once per run, after the options are parsed and before the first request;
 * stdout and the exit code are untouched.
 */
export function warnOnCleartext(deps: CliDeps, global: GlobalOptions): void {
  const problem = cleartextProblem(global.baseUrl ?? DEFAULT_BASE_URL);
  if (problem !== undefined) logOf(deps).warn("http", problem);
}

export interface ActionContext {
  client: ReturnType<CliDeps["createClient"]>;
  global: GlobalOptions;
  /** This command's own parsed options. */
  opts: Record<string, unknown>;
}

/**
 * Wrap an async command action with consistent global-option resolution and
 * client construction. The callback receives a context (client + resolved global
 * options + this command's options) and the command's positional arguments.
 *
 * Commander invokes actions as (arg1, ..., argN, options, command); we slice off
 * the trailing options object and command instance to recover the positionals.
 */
export function action(
  deps: CliDeps,
  fn: (ctx: ActionContext, positionals: string[]) => Promise<void>,
): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const positionals = args.slice(0, Math.max(0, args.length - 2)) as string[];
    const global = command.optsWithGlobals() as GlobalOptions;
    warnOnCleartext(deps, global);
    const client = deps.createClient(toEngineOptions(global));
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}
