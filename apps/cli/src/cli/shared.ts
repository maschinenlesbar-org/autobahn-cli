// Shared helpers used across CLI command groups: option parsers and the global option
// resolver. Results are written by output.ts.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import { logOf, type CliDeps } from "./io.js";
import type { OutputOptions } from "./output.js";
import { cleartextProblem, DEFAULT_BASE_URL, headerValueProblem, type EngineOptions } from "@maschinenlesbar.org/autobahn-client/internal/engine";
import { baseUrlProblem, idProblem, roadIdProblem } from "@maschinenlesbar.org/autobahn-client/internal/validate";
import type { RetryEvent } from "@maschinenlesbar.org/autobahn-client/internal/engine";

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

export interface GlobalOptions extends OutputOptions {
  baseUrl?: string;
  timeout?: number;
  userAgent?: string;
  maxRetries?: number;
  maxResponseBytes?: number;
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

/** `HTTP 503 from host: retry 1 of 3 in 2 s` (host only; whole seconds, ms under 1 s). */
export function retryMessage(event: RetryEvent): string {
  let host: string;
  try {
    host = new URL(event.url).host;
  } catch {
    host = "the server";
  }
  const why = event.status === undefined ? "connection reset" : `HTTP ${event.status}`;
  const wait = event.delayMs < 1000 ? `${event.delayMs} ms` : `${Math.round(event.delayMs / 1000)} s`;
  return `${why} from ${host}: retry ${event.retry} of ${event.maxRetries} in ${wait}`;
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
    const options = toEngineOptions(global);
    options.onRetry = (event) => logOf(deps).warn("http", retryMessage(event));
    // An answer delivered changed (invalid text replaced with U+FFFD) is never silent.
    options.onWarning = (message) => logOf(deps).warn("api", message);
    const client = deps.createClient(options);
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}

/**
 * Make giving a single-value option twice a usage error, on `command` and every subcommand:
 * commander keeps the last value silently, so `--timeout 1000 --timeout 0` switched the timeout
 * off with nothing telling the user a value was dropped. A repeatable option, declared the
 * commander way with an array default (`.option("--tag <t>", …, collect, [])`), is left alone:
 * each value adds to the list; so is a plain flag (`--compact --compact` means the same).
 *
 * A boolean that can be switched both ways is guarded too: an optional-value option
 * (`--is-foi [bool]`) and a negatable pair (`--x` / `--no-x`). commander calls no value parser
 * for a bare `--is-foi`, so `--is-foi false --is-foi` turned into true silently. Those are counted
 * per attribute from commander's `option:<name>` events, which fire for every occurrence. Call
 * it once on a freshly built program: the check counts per program.
 */
export function forbidRepeatedOptions(command: Command): void {
  const switches = new Set(command.options.filter((o) => o.negate || o.optional).map((o) => o.attributeName()));
  const seen = new Set<string>();
  for (const option of command.options) {
    const attribute = option.attributeName();
    if (switches.has(attribute)) {
      const names = command.options.filter((o) => o.attributeName() === attribute).map((o) => o.long ?? o.short);
      command.on(`option:${option.name()}`, () => {
        if (seen.has(attribute)) command.error(`error: ${names.join(" / ")} may be given only once.`, { code: "commander.optionRepeated" });
        seen.add(attribute);
      });
      continue;
    }
    if (!option.required || option.variadic || Array.isArray(option.defaultValue)) continue;
    const parse = option.parseArg;
    let given = false;
    const guarded = (value: string, previous: unknown): unknown => {
      if (given) throw new InvalidArgumentError(`${option.long ?? option.short} may be given only once.`);
      given = true;
      return parse === undefined ? value : parse(value, previous);
    };
    option.parseArg = guarded as typeof option.parseArg;
  }
  for (const child of command.commands) forbidRepeatedOptions(child);
}
