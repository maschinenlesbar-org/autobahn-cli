// Run the CLI and resolve to a process exit code. Kept separate from the bin
// shim so tests can call run() directly with injected deps and assert on the
// captured output and exit code without spawning a subprocess.

import { CommanderError, type Command } from "commander";
import { buildProgram, commandPath, defaultDeps } from "./program.js";
import type { CliDeps } from "./io.js";
import {
  AutobahnApiError,
  AutobahnError,
  AutobahnNotFoundError,
  AutobahnValidationError,
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

/** What scanArgv found in argv before commander parses it. */
export interface ArgvScan {
  /** A token names a command that does not exist (`autobahn services …`). */
  unknownCommand: boolean;
  /** Indexes of the help/version flags (DISPLAY_FLAGS) — never an option's value. */
  displayFlags: number[];
  /** The hidden `-v` version alias follows a command (`autobahn roads -v`). */
  versionAliasAfterCommand: boolean;
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
  const scan: ArgvScan = { unknownCommand: false, displayFlags: [], versionAliasAfterCommand: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--") break;
    if (token.startsWith("-")) {
      if (DISPLAY_FLAGS.has(token)) {
        scan.displayFlags.push(i);
        if (token === "-v" && path.length > 1) scan.versionAliasAfterCommand = true;
        continue;
      }
      if (token.includes("=")) continue;
      const option = path.flatMap((c) => c.options).find((o) => o.short === token || o.long === token);
      if (option?.required) i++;
      continue;
    }
    if (command === undefined || command.commands.length === 0) continue;
    const sub: Command | undefined = command.commands.find((c) => c.name() === token || c.aliases().includes(token));
    if (sub === undefined) scan.unknownCommand = true;
    else path.push(sub);
    command = sub;
  }
  return scan;
}

export async function run(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
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

  // An unknown command is the error, whatever help or version flag comes with it:
  // drop the flag so commander reports `unknown command '<name>'` (exit 1) instead of
  // showing help or printing the version (exit 0) — a false success for a script.
  const scan = scanArgv(program, argv);
  // `-v` is kept only as the old spelling of -V; after a command it is more likely a
  // "verbose" guess, and printing the version would drop the command silently.
  if (scan.versionAliasAfterCommand && !scan.unknownCommand) {
    deps.io.err(
      "error: -v is the version flag (use -V or --version); it only works before the command, " +
        "and this CLI has no verbose mode",
    );
    deps.io.err('(run "autobahn --help" for usage)');
    return 1;
  }
  const args = scan.unknownCommand ? argv.filter((_, i) => !scan.displayFlags.includes(i)) : argv;

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
      // forms lands on writeErr, so route it to stdout to match `--help`. Genuine
      // parse errors keep their own non-zero exit code and stay on stderr.
      const isHelp =
        err.code === "commander.help" || err.code === "commander.helpDisplayed";
      flush(isHelp);
      return isHelp ? 0 : err.exitCode;
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
      // exits 1 here like commander's own parse errors.
      deps.io.err(`Error: ${err.message}`);
      return 1;
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
