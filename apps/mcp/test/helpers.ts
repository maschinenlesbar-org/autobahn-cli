// Test helpers of this server's own tests and the adapters of the conformance tests: a mock of
// the Autobahn API (the road list, each road's service listings, the item details), and the
// client's transport helpers. The generic harness (a connection, a config, a log recorder, the
// HTTP server) is harness.ts.

import { jsonResponse, makeMockTransport, type MockTransport } from "@maschinenlesbar.org/autobahn-client/test/helpers";

export * from "@maschinenlesbar.org/autobahn-client/test/helpers";

/** A listing item as the API sends it (only the fields a test sets). */
export type Item = Record<string, unknown> & { identifier: string };

/** The API's path segment and envelope key of each service. */
const SEGMENT = ["roadworks", "webcam", "parking_lorry", "warning", "closure", "electric_charging_station"];

/**
 * The Autobahn API over `roads`: `/o/autobahn/` lists the road ids, a service listing of a known
 * road answers its items (none when not given), `/o/autobahn/details/<service>/<id>` the item
 * (an empty body for an unknown one, as the API does), anything else 404.
 */
export function autobahn(roads: Record<string, Partial<Record<string, Item[]>>>): MockTransport {
  return makeMockTransport((request) => {
    const path = new URL(request.url).pathname;
    if (path === "/o/autobahn/") return jsonResponse({ roads: Object.keys(roads) });
    const listing = path.match(/^\/o\/autobahn\/([^/]+)\/services\/([^/]+)$/);
    if (listing !== null) {
      const [, road, service] = listing as unknown as [string, string, string];
      if (!SEGMENT.includes(service)) return jsonResponse({ error: "not found" }, 404);
      return jsonResponse({ [service]: roads[decodeURIComponent(road)]?.[service] ?? [] });
    }
    const detail = path.match(/^\/o\/autobahn\/details\/([^/]+)\/([^/]+)$/);
    if (detail !== null) {
      const [, service, id] = detail as unknown as [string, string, string];
      const found = Object.values(roads)
        .flatMap((byService) => byService[service] ?? [])
        .find((item) => item.identifier === decodeURIComponent(id));
      return found === undefined ? { status: 200, headers: { "content-type": "application/json" }, body: Buffer.alloc(0) } : jsonResponse(found);
    }
    return jsonResponse({ error: "not found" }, 404);
  });
}

/** A traffic warning on the A1, with `extra` fields (a delay, a description). */
export const warning = (id: string, extra: Record<string, unknown> = {}): Item => ({
  identifier: id,
  title: `A1 | Köln - Dortmund ${id}`,
  subtitle: " Köln -> Dortmund",
  display_type: "WARNING",
  isBlocked: "false",
  future: false,
  description: ["Beginn: 19.11.26 um 08:00 Uhr", "Stau"],
  ...extra,
});
