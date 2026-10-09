// Assemble the full commander program. The program is built around an injectable
// CliDeps so the entire CLI can be driven in tests with a mocked client and
// captured output.

import type { EventEmitter } from "node:events";
import { Command, Help, InvalidArgumentError, Option } from "commander";
import type { CliDeps } from "./io.js";
import { defaultIO } from "./io.js";
import { AutobahnClient } from "../client/client.js";
import { MAX_TIMEOUT_MS } from "../client/http.js";
import { DEFAULT_BASE_URL, DEFAULT_USER_AGENT, MAX_RETRIES } from "../client/engine.js";
import { redactUrl } from "../client/errors.js";
import { VERSION } from "../client/version.js";
import { parseBaseUrl, parseBoundedInt, parseHeaderValue } from "./shared.js";
import { registerRoadsCommand } from "./commands/roads.js";
import { registerServiceCommands } from "./commands/services.js";
import { DEFAULT_LOG_FORMAT, logFormatProblem } from "./log.js";

export { VERSION } from "../client/version.js";

/** Default dependencies: real client + real stdout/stderr/filesystem. */
export const defaultDeps: CliDeps = {
  io: defaultIO,
  env: process.env,
  createClient: (options) => new AutobahnClient(options),
};

/** commander value-parser for `--log-format`. */
function parseLogFormat(value: string): string {
  const problem = logFormatProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return value;
}

export function buildProgram(deps: CliDeps = defaultDeps): Command {
  const program = new Command();
  // flag > AUTOBAHN_BASE_URL > default; an empty variable counts as unset.
  const baseUrlDefault = deps.env["AUTOBAHN_BASE_URL"] || DEFAULT_BASE_URL;

  program
    .name("autobahn")
    .description(
      "CLI for the open Autobahn App API - roadworks, traffic warnings, " +
        "closures, lorry parking, webcams and charging stations.",
    )
    // `-V, --version` as in the other maschinenlesbar CLIs (commander's default); `-v`,
    // this CLI's flag up to 0.1.0, keeps working as a hidden alias.
    .version(VERSION, "-V, --version", "output the version number")
    .addOption(new Option("-v", "output the version number").hideHelp())
    .addOption(
      new Option("--base-url <url>", "API base URL (env AUTOBAHN_BASE_URL); a user:password@ in it is sent as HTTP Basic auth")
        .argParser(parseBaseUrl)
        // The help shows the default without userinfo: a password in AUTOBAHN_BASE_URL
        // must not end up in --help output or CI logs.
        .default(baseUrlDefault, JSON.stringify(redactUrl(baseUrlDefault))),
    )
    .option(
      "--timeout <ms>",
      `per-request timeout in milliseconds (default 30000; 0 disables; at most ${MAX_TIMEOUT_MS}; ` +
        "a timed-out request is not retried)",
      parseBoundedInt(0, MAX_TIMEOUT_MS),
    )
    .option(
      "--user-agent <ua>",
      `User-Agent header value (default: "${DEFAULT_USER_AGENT}")`,
      parseHeaderValue,
    )
    .option(
      "--max-retries <n>",
      "retries for transient 429/502/503/504 responses and reset connections (default 2, 0..10; " +
        "waits Retry-After, else backs off — up to 3–5 min in total at 10; details in README)",
      parseBoundedInt(0, MAX_RETRIES),
    )
    .option(
      "--max-response-bytes <n>",
      "cap response body size in bytes (0 = unlimited; default 100 MiB)",
      parseBoundedInt(0, Number.MAX_SAFE_INTEGER),
    )
    .option(
      "--log-format <format>",
      `how errors, warnings and notes are written to stderr: text (log4j style: time, level, [topic], message) or jsonl (one JSON object per line: ts, level, topic, msg); default ${DEFAULT_LOG_FORMAT}`,
      parseLogFormat,
    )
    .option("--compact", "print JSON on a single line instead of pretty-printed");

  // Command is an EventEmitter at runtime; commander's typings only expose on().
  program.on("option:v", () => (program as unknown as EventEmitter).emit("option:version"));

  // commander runs value parsers on flags but not on defaults, so a base URL taken from
  // AUTOBAHN_BASE_URL is checked here, before any command runs (a usage error, exit 2).
  // The help command never makes a request: help must work whatever the variable holds.
  program.hook("preAction", (_program, actionCommand) => {
    if (actionCommand.name() === "help") return;
    if (program.getOptionValueSource("baseUrl") !== "default") return;
    try {
      parseBaseUrl(program.opts<{ baseUrl: string }>().baseUrl);
    } catch (err) {
      if (!(err instanceof InvalidArgumentError)) throw err;
      program.error(`error: AUTOBAHN_BASE_URL: ${err.message}`);
    }
  });

  registerRoadsCommand(program, deps);
  registerServiceCommands(program, deps);
  addHelpCommands(program);
  showGlobalOptions(program);

  return program;
}

/**
 * List the root's options under "Global Options" in every subcommand's help: they work
 * after the subcommand too (`autobahn roads --compact`), but `roads --help` showed only
 * `-h, --help`. Merged into each command's help configuration (the help commands set
 * `visibleCommands`).
 */
function showGlobalOptions(command: Command): void {
  // The version flag is a usage error after a command, so a subcommand's help leaves it
  // out of its global options (the root's own help still lists it).
  const base = Object.assign(new Help(), { showGlobalOptions: true });
  command.configureHelp({
    ...command.configureHelp(),
    showGlobalOptions: true,
    visibleGlobalOptions: (cmd: Command) => base.visibleGlobalOptions(cmd).filter((o) => o.long !== "--version"),
  });
  for (const sub of command.commands) showGlobalOptions(sub);
}

/**
 * The closest of `names` to a mistyped `word`, as commander suggests for an unknown
 * command: an edit distance (insert, delete, substitute, swap neighbours) of at most 2
 * that changes less than 60 % of the word, ignoring case (commander's own comparison is
 * case-sensitive, so `ROADWORKS` got no hint). Undefined when nothing is that close.
 */
export function suggestCommand(word: string, names: string[]): string | undefined {
  let best: { name: string; distance: number } | undefined;
  for (const name of names) {
    const distance = editDistance(word.toLowerCase(), name.toLowerCase());
    const similar = (Math.max(word.length, name.length) - distance) / Math.max(word.length, name.length) > 0.4;
    if (distance <= 2 && similar && (best === undefined || distance < best.distance)) best = { name, distance };
  }
  return best?.name;
}

/** `autobahn roadworks list` for the `list` command. */
export function commandPath(command: Command): string {
  const names: string[] = [];
  for (let c: Command | null = command; c !== null; c = c.parent) names.unshift(c.name());
  return names.join(" ");
}

/** Optimal-string-alignment distance between `a` and `b`. */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[a.length]![b.length]!;
}

/**
 * Replace commander's built-in `help [command]` on every command that has subcommands.
 * The built-in one only looks one level down and shows help for anything it cannot
 * find: `autobahn help roadworks list` printed the `roadworks` help, and
 * `autobahn help foo` printed the root help with exit 0. This one walks the whole path
 * and reports an unknown name as `unknown command` (exit 2). It is hidden, so the
 * generated site reference does not list it per group, and put back into the help
 * output's command list where the built-in one was.
 */
function addHelpCommands(command: Command): void {
  const groups = command.commands;
  if (groups.length === 0) return;
  for (const sub of [...groups]) addHelpCommands(sub);
  command.helpCommand(false);
  const help = command
    .command("help", { hidden: true })
    .description("Display help for a command (e.g. help roadworks list)")
    .argument("[command...]", "the command to describe, e.g. roadworks list")
    .action((names: string[]) => {
      let target: Command = command;
      for (const name of names) {
        if (target.commands.length === 0) {
          // `help roads extra`: `roads` takes no subcommands at all — say that.
          target.error(`error: '${commandPath(target)}' has no subcommands (got '${name}')`, {
            exitCode: 1,
            code: "commander.unknownCommand",
          });
        }
        const sub = target.commands.find((c) => c.name() === name || c.aliases().includes(name));
        if (sub === undefined) {
          const hint = suggestCommand(name, target.commands.filter((c) => c.name() !== "help").map((c) => c.name()));
          target.error(`error: unknown command '${name}'${hint === undefined ? "" : `\n(Did you mean ${hint}?)`}`, {
            exitCode: 1,
            code: "commander.unknownCommand",
          });
        }
        target = sub;
      }
      target.outputHelp();
    });
  command.configureHelp({
    visibleCommands: (cmd) => [...cmd.commands.filter((c) => c !== help && c.name() !== "help"), help],
  });
}
