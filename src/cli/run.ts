// Run the CLI and resolve to a process exit code. Kept separate from the bin
// shim so tests can call run() directly with injected deps and assert on the
// captured output and exit code without spawning a subprocess.

import { CommanderError, type Command } from "commander";
import { buildProgram, commandPath, defaultDeps, suggestCommand } from "./program.js";
import type { CliDeps } from "./io.js";
import {
  AutobahnApiError,
  AutobahnError,
  AutobahnNotFoundError,
  AutobahnValidationError,
  credentialsIn,
  redactCredentials,
} from "../client/errors.js";

interface OutputSink {
  out: string[];
  err: string[];
}

/**
 * Apply exitOverride + output redirection to every command in the tree.
 * commander does not propagate these to subcommands, so a parse error on a
 * subcommand would otherwise call process.exit() and bypass our error handling.
 *
 * Commander's own output (help, version, parse-error text) is buffered into
 * `sink` so run() can route it *after* it knows the outcome: a help display goes
 * to stdout (matching `--help`), genuine errors to stderr. Action output is
 * written through deps.io directly and never passes through here.
 */
function configureTree(command: Command, sink: OutputSink): void {
  command.exitOverride();
  // After a parse error, point at the command's own help in one line instead of
  // printing the whole help (25+ lines for a root option), which scrolled the actual
  // error off a small terminal or CI log. Set on every command: commander does not
  // propagate it.
  command.showHelpAfterError(`(run "${commandPath(command)} --help" for usage)`);
  command.configureOutput({
    writeOut: (str) => sink.out.push(str.replace(/\n$/, "")),
    writeErr: (str) => sink.err.push(str.replace(/\n$/, "")),
    // The error message alone (help after an error goes through writeErr): escape it,
    // keeping the line break before commander's own "(Did you mean …?)" hint.
    outputError: (str, write) => write(escapeCommanderError(str.replace(/\n$/, ""))),
  });
  for (const child of command.commands) configureTree(child, sink);
}

/**
 * Replace the userinfo of every URL in `text` with `***`, the form `redactUrl` gives
 * (`https://user:secret@host` becomes `https://***@host`). Text-based, so it also
 * covers a URL that does not parse; the last `@` before the host ends the userinfo.
 */
export function redactUserinfo(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#']*@/gi, "$1***@");
}

/**
 * Escape the characters a terminal acts on in one commander error message: C0 controls
 * (newline included, tab excepted), DEL, C1 and Unicode format characters (bidi
 * overrides, zero-width characters) become `\uXXXX`. Commander repeats a rejected
 * argument raw ("command-argument value '<value>' is invalid"), and a road id can come
 * from a pipeline: a newline in it could forge an `Error:` line, an override reorder
 * the line. The library escapes the values it echoes itself (`quoteValue`).
 */
export function escapeTerminalText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]|\p{Cf}/gu, (ch) =>
    Array.from({ length: ch.length }, (_, i) => `\\u${ch.charCodeAt(i).toString(16).padStart(4, "0")}`).join(""),
  );
}

/**
 * escapeTerminalText for one commander error message, except for the
 * `\n(Did you mean …?)` line commander appends after an unknown command or option.
 * That hint is built from this CLI's own command and option names, and it can only
 * end the message: commander quotes the user's value (`unknown command '<value>'`), so
 * a value that contains the same text is followed by its closing quote and stays
 * escaped. Escaping the whole message printed `…'roadwork'\u000a(Did you mean …?)`.
 */
export function escapeCommanderError(message: string): string {
  const hint = /\n\(Did you mean [^\n]*\?\)$/.exec(message);
  if (hint === null) return escapeTerminalText(message);
  return escapeTerminalText(message.slice(0, hint.index)) + hint[0];
}

/** Flags that make commander print something and exit 0: help, and the version (`-v` is its alias). */
const DISPLAY_FLAGS = new Set(["-h", "--help", "-V", "--version", "-v"]);

/** The version flags among DISPLAY_FLAGS. */
const VERSION_FLAGS = new Set(["-V", "--version", "-v"]);

/** `["-v", "-h"]` for `-vh` when every letter is a display flag, else undefined. */
function combinedDisplayFlags(token: string): string[] | undefined {
  if (!/^-[A-Za-z]{2,}$/.test(token)) return undefined;
  const flags = [...token.slice(1)].map((c) => `-${c}`);
  return flags.every((f) => DISPLAY_FLAGS.has(f)) ? flags : undefined;
}

/** What scanArgv found in argv before commander parses it. */
export interface ArgvScan {
  /** A token names a command that does not exist (`autobahn services …`). */
  unknownCommand: boolean;
  /** The first token that names no command, and the command it was looked up under. */
  unknown?: { name: string; parent: Command };
  /** Indexes of the help/version flags (DISPLAY_FLAGS) — never an option's value. */
  displayFlags: number[];
  /** A version flag (`-V`, `--version`, or the hidden `-v`) follows a command (`autobahn roads -V`). */
  versionFlagAfterCommand: boolean;
  /** Indexes of -h/--help after the `help` command (`help roadworks list --help`). */
  helpFlagsOnHelpCommand: number[];
  /** A flag that takes no value, given one (`--compact=1`). */
  valueOnBooleanFlag?: string;
}

/**
 * Walk `argv` along the command tree. Commander answers `--help` and `--version` before
 * it checks the command, so `autobahn services --help` printed the root help and exited
 * 0 — a false success for a script probing for a command. Options are skipped with
 * their value when they take one, so `--base-url <url>` is not read as a command and
 * `--user-agent -h` is not read as a help flag; scanning stops at `--`. Past a command
 * without subcommands (or an unknown one) only flags are collected.
 */
export function scanArgv(program: Command, argv: string[]): ArgvScan {
  let command: Command | undefined = program;
  const path: Command[] = [program];
  const scan: ArgvScan = { unknownCommand: false, displayFlags: [], versionFlagAfterCommand: false, helpFlagsOnHelpCommand: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--") break;
    if (token.startsWith("-")) {
      // Commander splits combined short flags (`-vh` → `-v -h`), so read a token made
      // only of display-flag letters the same way.
      const flags = DISPLAY_FLAGS.has(token) ? [token] : combinedDisplayFlags(token);
      if (flags !== undefined) {
        scan.displayFlags.push(i);
        if (path.length > 1 && flags.some((f) => VERSION_FLAGS.has(f))) scan.versionFlagAfterCommand = true;
        if (path.length > 1 && path[path.length - 1]!.name() === "help" && (token === "-h" || token === "--help")) {
          scan.helpFlagsOnHelpCommand.push(i);
        }
        continue;
      }
      if (token.includes("=")) {
        const name = token.slice(0, token.indexOf("="));
        const flag = path.flatMap((c) => c.options).find((o) => o.long === name);
        if (flag !== undefined && !flag.required && !flag.optional) scan.valueOnBooleanFlag ??= token;
        continue;
      }
      const option = path.flatMap((c) => c.options).find((o) => o.short === token || o.long === token);
      if (option?.required) i++;
      continue;
    }
    if (command === undefined || command.commands.length === 0) continue;
    const sub: Command | undefined = command.commands.find((c) => c.name() === token || c.aliases().includes(token));
    if (sub === undefined) {
      scan.unknownCommand = true;
      scan.unknown ??= { name: token, parent: command };
    } else path.push(sub);
    command = sub;
  }
  return scan;
}

/**
 * Exit code of a usage error — a command, option or argument the CLI rejects before any
 * request. Distinct from 1 (an API, network or parse failure), so a script or skill can
 * tell "fix the command" from "the upstream failed" without reading stderr.
 */
export const USAGE_ERROR = 2;

/**
 * `deps` with an `io` that redacts the credentials of every argument and of
 * AUTOBAHN_BASE_URL from everything it prints. Commander echoes rejected values in its
 * errors, the CLI's own messages name unknown commands and option values, and help shows the
 * base URL's default: whatever path a credential takes to stdout or stderr, the exact
 * userinfo (as `credentialsIn` finds it, plus its terminal-escaped and JSON-quoted forms) is
 * replaced by `***`. A pattern alone can't delimit a password with spaces, quotes, `#`, `?`
 * or `/`; the exact strings can. Without credentials the output passes through unchanged.
 */
export function withRedactedOutput(deps: CliDeps, argv: readonly string[]): CliDeps {
  // An `--option=value` token is echoed as its value alone.
  const values = argv.map((token) => (token.startsWith("-") && token.includes("=") ? token.slice(token.indexOf("=") + 1) : token));
  const sources = [...argv, ...values, deps.env["AUTOBAHN_BASE_URL"] ?? ""];
  const secrets = new Set<string>();
  for (const source of sources) {
    for (const secret of credentialsIn(source)) {
      secrets.add(secret);
      secrets.add(escapeTerminalText(secret));
      secrets.add(JSON.stringify(secret).slice(1, -1));
    }
  }
  if (secrets.size === 0) return deps;
  const list = [...secrets];
  const redact = (text: string): string => redactUserinfo(redactCredentials(text, list));
  return { ...deps, io: { out: (text) => deps.io.out(redact(text)), err: (text) => deps.io.err(redact(text)) } };
}

export async function run(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
  deps = withRedactedOutput(deps, argv);
  const program = buildProgram(deps);
  const sink: OutputSink = { out: [], err: [] };
  configureTree(program, sink);

  // Flush commander's buffered output. `helpToStdout` routes the buffered writeErr
  // lines to stdout: commander emits no-command help (a bare invocation, a global
  // flag with no command, or a bare command group) via writeErr, and we want that
  // to match an explicit `--help` (stdout, exit 0) rather than landing on stderr.
  // Commander's parse errors repeat a rejected argument raw ("argument '<value>' is
  // invalid."), so the userinfo of any URL in them is redacted, as the library does.
  const flush = (helpToStdout: boolean): void => {
    for (const line of sink.out) deps.io.out(line);
    const errSink = helpToStdout ? deps.io.out : deps.io.err;
    for (const line of sink.err) errSink(redactUserinfo(line));
  };

  // Read argv against the command tree before commander parses it: an unknown command,
  // a version flag after a command, help flags after `help` and a value on a boolean
  // flag each need a different answer than commander would give.
  const scan = scanArgv(program, argv);
  // A version flag after a command would print the version and drop the command
  // silently (and `-v` there is more likely a "verbose" guess): a usage error instead.
  if (scan.versionFlagAfterCommand && !scan.unknownCommand) {
    deps.io.err(
      "error: the version flag (-V, --version, or -v) only works before the command " +
        "(`autobahn --version`); this CLI has no verbose mode",
    );
    deps.io.err('(run "autobahn --help" for usage)');
    return USAGE_ERROR;
  }
  // Commander answers `--compact=1` with "unknown option … (Did you mean --compact?)",
  // which doesn't say why; `--timeout=…` works, so say that this flag takes no value.
  if (scan.valueOnBooleanFlag !== undefined) {
    const name = scan.valueOnBooleanFlag.slice(0, scan.valueOnBooleanFlag.indexOf("="));
    deps.io.err(`error: option '${name}' takes no value (got '${escapeTerminalText(scan.valueOnBooleanFlag)}')`);
    deps.io.err('(run "autobahn --help" for usage)');
    return USAGE_ERROR;
  }
  // An unknown command is reported here rather than by commander: its "Did you mean"
  // compares case-sensitively (`ROADWORKS` got no hint), and any help or version flag
  // given with it must not turn the error into a success.
  if (scan.unknown !== undefined) {
    const { name, parent } = scan.unknown;
    const hint = suggestCommand(name, parent.commands.filter((c) => c.name() !== "help").map((c) => c.name()));
    deps.io.err(escapeCommanderError(`error: unknown command '${name}'${hint === undefined ? "" : `\n(Did you mean ${hint}?)`}`));
    deps.io.err(`(run "${commandPath(parent)} --help" for usage)`);
    return USAGE_ERROR;
  }
  // `help <path> --help` asks for the help of <path>, which the help command prints;
  // left in, commander would answer the --help with the help command's own help.
  const drop = scan.helpFlagsOnHelpCommand;
  const args = argv.filter((_, i) => !drop.includes(i));

  try {
    await program.parseAsync(args, { from: "user" });
    flush(false);
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      // A help/version display is a success: commander shows the requested text —
      // help from an explicit `--help` ("commander.helpDisplayed") or from a bare
      // invocation / global-flag-only / bare command group ("commander.help"), or
      // the version from `--version` — so we exit 0. Help written for those bare
      // forms lands on writeErr, so route it to stdout to match `--help`. Every other
      // commander error is a usage error (unknown command or option, a rejected or
      // missing argument): exit 2, on stderr.
      const isHelp =
        err.code === "commander.help" || err.code === "commander.helpDisplayed";
      flush(isHelp);
      return isHelp || err.exitCode === 0 ? 0 : USAGE_ERROR;
    }
    flush(false);
    if (err instanceof AutobahnApiError) {
      deps.io.err(`Error: ${err.message}`);
      // Map a few notable statuses to distinct exit codes for scripting.
      if (err.status === 404) return 4;
      return 1;
    }
    if (err instanceof AutobahnValidationError) {
      // An input the library rejected before any request: a usage error, which
      // exits 2 like commander's own parse errors.
      deps.io.err(`Error: ${err.message}`);
      return USAGE_ERROR;
    }
    if (err instanceof AutobahnNotFoundError) {
      // e.g. an unknown road id: not found, like a 404.
      deps.io.err(`Error: ${err.message}`);
      return 4;
    }
    if (err instanceof AutobahnError) {
      deps.io.err(`Error: ${err.message}`);
      return 1;
    }
    deps.io.err(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
