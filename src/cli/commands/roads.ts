import type { Command } from "commander";
import type { CliDeps } from "../io.js";
import { action, renderJson } from "../shared.js";

export function registerRoadsCommand(program: Command, deps: CliDeps): void {
  program
    .command("roads")
    .description("List all motorways the API knows about (e.g. A1, A2, ...)")
    .action(
      action(deps, async ({ client, global }) => {
        renderJson(deps, global, await client.roads());
      }),
    );
}
