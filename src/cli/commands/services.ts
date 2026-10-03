// Registers the six Autobahn service command groups. They are structurally
// identical (`list <roadId>` + `get <id>`), so they are generated from a table
// rather than hand-written six times.

import type { Command } from "commander";
import type { CliDeps } from "../io.js";
import { action, renderJson } from "../shared.js";
import type { AutobahnClient } from "../../client/client.js";

type ServiceKey =
  | "roadworks"
  | "webcams"
  | "parkingLorries"
  | "warnings"
  | "closures"
  | "chargingStations";

interface ServiceSpec {
  /** CLI command name. */
  command: string;
  /** Client resource accessor. */
  resource: ServiceKey;
  /** Human description for the command group. */
  description: string;
  /** What `list` lists, for its help line ("List <noun> along a motorway"). */
  noun: string;
}

const SERVICES: ServiceSpec[] = [
  { command: "roadworks", resource: "roadworks", description: "Roadworks along a motorway", noun: "roadworks" },
  { command: "webcams", resource: "webcams", description: "Webcams along a motorway", noun: "webcams" },
  {
    command: "parking",
    resource: "parkingLorries",
    description: "Lorry parking areas along a motorway",
    noun: "lorry parking areas",
  },
  {
    command: "warnings",
    resource: "warnings",
    description: "Traffic warnings along a motorway",
    noun: "traffic warnings",
  },
  { command: "closures", resource: "closures", description: "Closures along a motorway", noun: "closures" },
  {
    command: "charging",
    resource: "chargingStations",
    description: "Electric charging stations along a motorway",
    noun: "electric charging stations",
  },
];

export function registerServiceCommands(program: Command, deps: CliDeps): void {
  for (const spec of SERVICES) {
    const group = program.command(spec.command).description(spec.description);

    group
      .command("list <roadId>")
      .description(`List ${spec.noun} along a motorway (e.g. A1)`)
      .action(
        action(deps, async ({ client, global }, [roadId]) => {
          const resource = client[spec.resource] as AutobahnClient[ServiceKey];
          renderJson(deps, global, await resource.list(roadId!));
        }),
      );

    group
      .command("get <identifier>")
      .description("Fetch one item's details by its identifier")
      .action(
        action(deps, async ({ client, global }, [identifier]) => {
          const resource = client[spec.resource] as AutobahnClient[ServiceKey];
          renderJson(deps, global, await resource.get(identifier!));
        }),
      );
  }
}
