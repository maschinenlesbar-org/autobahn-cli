// Assemble the full commander program. The program is built around an injectable
// CliDeps so the entire CLI can be driven in tests with a mocked client and
// captured output.

import { Command } from "commander";
import type { CliDeps } from "./io.js";
import { defaultIO } from "./io.js";
import { AutobahnClient } from "../client/client.js";
import { parseIntArg } from "./shared.js";
import { registerRoadsCommand } from "./commands/roads.js";
import { registerServiceCommands } from "./commands/services.js";

export const VERSION = "1.0.0";

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
      "CLI for the open Autobahn App API (https://verkehr.autobahn.de) — roadworks, " +
        "traffic warnings, closures, lorry parking, webcams and charging stations.",
    )
    .version(VERSION)
    .option("--base-url <url>", "API base URL", "https://verkehr.autobahn.de")
    .option("--timeout <ms>", "per-request timeout in milliseconds", parseIntArg)
    .option("--user-agent <ua>", "User-Agent header value")
    .option("--max-retries <n>", "retries for transient 429/503 responses", parseIntArg)
    .option(
      "--max-response-bytes <n>",
      "cap response body size in bytes (0 = unlimited; default 100 MiB)",
      parseIntArg,
    )
    .option("--compact", "print JSON on a single line instead of pretty-printed")
    .showHelpAfterError();

  registerRoadsCommand(program, deps);
  registerServiceCommands(program, deps);

  return program;
}
