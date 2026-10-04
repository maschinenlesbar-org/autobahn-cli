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
      `per-request timeout in milliseconds (0 disables; at most ${MAX_TIMEOUT_MS})`,
      parseBoundedInt(0, MAX_TIMEOUT_MS),
    )
    .option("--user-agent <ua>", "User-Agent header value", parseHeaderValue)
    .option(
      "--max-retries <n>",
      "retries for transient 429/502/503/504 responses and reset connections (0..10; each waits the server's " +
        "Retry-After, up to 30 s, else a short linear backoff from 200 ms)",
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
        const sub = target.commands.find((c) => c.name() === name || c.aliases().includes(name));
        if (sub === undefined) {
          target.error(`error: unknown command '${name}'`, { exitCode: 1, code: "commander.unknownCommand" });
        }
        target = sub;
      }
      target.outputHelp();
    });
  command.configureHelp({
    visibleCommands: (cmd) => [...cmd.commands.filter((c) => c !== help && c.name() !== "help"), help],
  });
}
