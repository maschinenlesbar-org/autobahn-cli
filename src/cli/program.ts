// Assemble the full commander program. The program is built around an injectable
// CliDeps so the entire CLI can be driven in tests with a mocked client and
// captured output.

import type { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command, Option } from "commander";
import type { CliDeps } from "./io.js";
import { defaultIO } from "./io.js";
import { AutobahnClient } from "../client/client.js";
import { MAX_TIMEOUT_MS } from "../client/http.js";
import { DEFAULT_BASE_URL, MAX_RETRIES } from "../client/engine.js";
import { parseBaseUrl, parseBoundedInt, parseHeaderValue } from "./shared.js";
import { registerRoadsCommand } from "./commands/roads.js";
import { registerServiceCommands } from "./commands/services.js";

/**
 * Single source of truth for the version: read from package.json at runtime
 * rather than duplicating a literal that can silently drift after a release bump.
 * From the compiled location (dist/src/cli/program.js) package.json is three
 * directories up; the same offset holds for the source under src/cli.
 */
function readVersion(): string {
  try {
    const pkgUrl = new URL("../../../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = readVersion();

/** Default dependencies: real client + real stdout/stderr/filesystem. */
export const defaultDeps: CliDeps = {
  io: defaultIO,
  createClient: (options) => new AutobahnClient(options),
};

export function buildProgram(deps: CliDeps = defaultDeps): Command {
  const program = new Command();

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
    .option(
      "--base-url <url>",
      "API base URL (a user:password@ in it is sent as HTTP Basic auth)",
      parseBaseUrl,
      DEFAULT_BASE_URL,
    )
    .option(
      "--timeout <ms>",
      `per-request timeout in milliseconds (default 30000; 0 disables; at most ${MAX_TIMEOUT_MS}; ` +
        "a timed-out request is not retried)",
      parseBoundedInt(0, MAX_TIMEOUT_MS),
    )
    .option("--user-agent <ua>", "User-Agent header value", parseHeaderValue)
    .option(
      "--max-retries <n>",
      "retries for transient 429/502/503/504 responses and reset connections (0..10; each waits the server's " +
        "Retry-After, up to 30 s, else a short linear backoff from 200 ms — for a 429 from 1 s, doubling)",
      parseBoundedInt(0, MAX_RETRIES),
    )
    .option(
      "--max-response-bytes <n>",
      "cap response body size in bytes (0 = unlimited; default 100 MiB)",
      parseBoundedInt(0, Number.MAX_SAFE_INTEGER),
    )
    .option("--compact", "print JSON on a single line instead of pretty-printed");

  // Command is an EventEmitter at runtime; commander's typings only expose on().
  program.on("option:v", () => (program as unknown as EventEmitter).emit("option:version"));

  registerRoadsCommand(program, deps);
  registerServiceCommands(program, deps);
  addHelpCommands(program);

  return program;
}

/**
 * The closest of `names` to a mistyped `word`, as commander suggests for an unknown
 * command: an edit distance (insert, delete, substitute, swap neighbours) of at most 2
 * that changes less than 60 % of the word. Undefined when nothing is that close.
 */
export function suggestCommand(word: string, names: string[]): string | undefined {
  let best: { name: string; distance: number } | undefined;
  for (const name of names) {
    const distance = editDistance(word, name);
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
 * and reports an unknown name as `unknown command` (exit 1). It is hidden, so the
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
    .description("display help for command")
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
