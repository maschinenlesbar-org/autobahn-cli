import type { Command } from "commander";
import type { CliDeps } from "../io.js";
import { action, renderJson } from "../shared.js";

export function registerRoadsCommand(program: Command, deps: CliDeps): void {
  program
    .command("roads")
    .description("List all motorways the API knows about (e.g. A1, A2, ...)")
    .action(
      action(deps, async ({ client, global }) => {
        renderJson(deps, global, tidyRoadIds(await client.roads()));
      }),
    );
}

/**
 * Trim each id and drop duplicates, keeping the first occurrence. The upstream
 * list carries both "A60" and "A60 "; `list` trims its argument, so both name
 * the same road and a list built from `roads` would otherwise repeat it.
 */
function tidyRoadIds(roads: string[]): string[] {
  return [...new Set(roads.map((id) => id.trim()).filter((id) => id !== ""))];
}
