// The use cases of the skills against a mock of the API, with the skills' traps as cases.

import { test } from "node:test";
import assert from "node:assert/strict";
import { AutobahnClient, AutobahnNotFoundError, checkRoad, findChargingStations, latLong } from "../src/index.js";
import { jsonResponse, makeMockTransport } from "./helpers.js";

/** The API over `roads`: the road list and each road's service listings. */
function client(roads: Record<string, Record<string, unknown[]>>): AutobahnClient {
  const transport = makeMockTransport((request) => {
    const path = new URL(request.url).pathname;
    if (path === "/o/autobahn/") return jsonResponse({ roads: Object.keys(roads) });
    const m = path.match(/^\/o\/autobahn\/([^/]+)\/services\/([^/]+)$/);
    if (m === null) return jsonResponse({ error: "not found" }, 404);
    return jsonResponse({ [m[2] as string]: roads[decodeURIComponent(m[1] as string)]?.[m[2] as string] ?? [] });
  });
  return new AutobahnClient({ transport: transport.transport });
}

const item = (identifier: string, extra: Record<string, unknown>) => ({ identifier, title: `A1 | ${identifier}`, isBlocked: "false", future: false, description: [], ...extra });

test("checkRoad classifies by display_type: a real-time closure in the warnings listing counts as a closure", async () => {
  const answer = await checkRoad(
    client({ A1: { warning: [item("inrix-closed", { display_type: "CLOSURE", description: ["Fahrbahn gesperrt"] })], closure: [], roadworks: [] } }),
    { roadId: "A1" },
  );
  assert.deepEqual(answer.counts, { warnings: 0, closures: 1, rampClosures: 0, roadworks: 0, planned: 0 });
  assert.deepEqual(answer.blocking.map((i) => i.identifier), ["inrix-closed"]);
});

test("checkRoad: a ramp closure says Vollsperrung and still never blocks the road", async () => {
  const answer = await checkRoad(client({ A1: { closure: [item("ramp", { display_type: "CLOSURE_ENTRY_EXIT", description: ["Vollsperrung der Auffahrt"] })] } }), { roadId: "A1" });
  assert.equal(answer.counts.rampClosures, 1);
  assert.deepEqual(answer.blocking, []);
});

test("checkRoad: isBlocked true blocks; a planned item never does; a plain lane closure doesn't", async () => {
  const answer = await checkRoad(
    client({
      A1: {
        roadworks: [
          item("blocked", { display_type: "ROADWORKS", isBlocked: "true" }),
          item("later", { display_type: "ROADWORKS", future: true, description: ["Vollsperrung"] }),
          item("lane", { display_type: "ROADWORKS", description: ["Fahrstreifen verengt"] }),
        ],
      },
    }),
    { roadId: "A1" },
  );
  assert.deepEqual(answer.blocking.map((i) => i.identifier), ["blocked"]);
  assert.equal(answer.counts.planned, 1);
});

test("checkRoad: delays rank as numbers, not strings; an accident is a hazard whatever its delay", async () => {
  const answer = await checkRoad(
    client({
      A1: {
        warning: [
          item("five", { display_type: "WARNING", delayTimeValue: "5" }),
          item("thirtyseven", { display_type: "WARNING", delayTimeValue: "37" }),
          item("crash", { display_type: "WARNING", description: ["Unfall"] }),
          item("none", { display_type: "WARNING", delayTimeValue: null }),
        ],
      },
    }),
    { roadId: "A1" },
  );
  assert.deepEqual(answer.worstDelays.map((i) => i.identifier), ["thirtyseven", "five"]);
  assert.deepEqual(answer.hazards.map((i) => i.identifier), ["crash"]);
});

test("checkRoad: an unknown road is the client's not-found with a did-you-mean, never an all-clear", async () => {
  await assert.rejects(checkRoad(client({ A1: {} }), { roadId: "a1" }), (err: unknown) => err instanceof AutobahnNotFoundError && /did you mean "A1"/.test(err.message));
});

test("latLong reads both coordinate shapes and refuses what isn't a number", () => {
  assert.deepEqual(latLong({ lat: "52.5", long: "13.4" }), [52.5, 13.4]);
  assert.deepEqual(latLong({ type: "Point", coordinates: [13.4, 52.5] }), [52.5, 13.4]);
  assert.equal(latLong({ lat: "x", long: "13.4" }), undefined);
  assert.equal(latLong(undefined), undefined);
});

test("latLong: a blank or null coordinate is no position, not 0", () => {
  assert.equal(latLong({ lat: "", long: "" }), undefined);
  assert.equal(latLong({ lat: " ", long: "13.4" }), undefined);
  assert.equal(latLong({ lat: null, long: null } as never), undefined);
  assert.equal(latLong({ type: "Point", coordinates: [null, null] } as never), undefined);
  assert.deepEqual(latLong({ lat: "0", long: "0" }), [0, 0]);
});

test("findChargingStations: a site with blank coordinates comes last and doesn't change the road's axis", async () => {
  const site = (id: string, long: string) => item(id, { title: `A2 | x | ${id}`, coordinate: { lat: long === "" ? "" : "52.3", long } });
  const answer = await findChargingStations(client({ A2: { electric_charging_station: [site("blank", ""), site("e", "13"), site("w", "7"), site("m", "9")] } }), { roadId: "A2" });
  assert.equal(answer.orderedBy, "longitude");
  assert.equal(answer.withoutPosition, 1);
  assert.deepEqual(answer.stations.map((s) => s.identifier), ["w", "m", "e", "blank"]);
});

test("findChargingStations orders west to east on an east-west road; trailing spaces in lines don't hide points", async () => {
  const answer = await findChargingStations(
    client({
      A4: {
        electric_charging_station: [
          item("east", { title: "A4 | Dresden | Ost", coordinate: { lat: "51.0", long: "13.0" }, description: ["4 Ladepunkte ", "150 kW"] }),
          item("west", { title: "A4 | Aachen | West", coordinate: { lat: "50.8", long: "6.1" }, description: ["Ladepunkt 1: ", "50 kW"] }),
        ],
      },
    }),
    { roadId: "A4" },
  );
  assert.equal(answer.orderedBy, "longitude");
  assert.deepEqual(answer.stations.map((s) => [s.identifier, s.points, s.maxKw]), [["west", 1, 50], ["east", 4, 150]]);
});

test("checkRoad: every carriageway closure (CLOSURE) not planned is blocking, whatever words its description uses", async () => {
  // Real closure descriptions name the cause or say "Sperrung", rarely "gesperrt" (the A1 at the
  // Kamener Kreuz, November 2026): the type is what says the carriageway is closed.
  const answer = await checkRoad(
    client({
      A1: {
        closure: [
          item("bridge", { display_type: "CLOSURE", description: ["Zeitraum dieser Bauphase:", "A1 - Ersatzneubau BW B1 über A1"] }),
          item("sperrung", { display_type: "CLOSURE", description: ["A1 Sperrung Richtungsfahrbahn wegen GST Löstertalbrücke"] }),
          item("later", { display_type: "CLOSURE", future: true, description: ["Brückenneubau"] }),
        ],
      },
    }),
    { roadId: "A1" },
  );
  assert.deepEqual(answer.blocking.map((i) => i.identifier), ["bridge", "sperrung"]);
});

test("checkRoad: roadworks block only when they say the road is shut, not a lane, a car park, a rest area or a negation", async () => {
  const works = (id: string, ...description: string[]) => item(id, { display_type: "ROADWORKS", description });
  const answer = await checkRoad(
    client({
      A1: {
        roadworks: [
          works("lane", "rechter Fahrstreifen gesperrt"),
          works("lane-of-carriageway", "rechter Fahrstreifen der Richtungsfahrbahn Bremen gesperrt"),
          works("negated", "Die Fahrbahn ist nicht gesperrt"),
          works("no-full", "keine Vollsperrung"),
          works("car-park", "Parkplatz Waldblick gesperrt"),
          // A live A1 roadworks: a speed and width limit, the project's last line names a closed rest area.
          works("rest-area", "Länge: 0.3 km | Max. 100 km/h | Maximale Durchfahrtsbreite: 10.35 m", "A1 - Ersatzneubau BW K147 - Rastanlage Ahrensfeld West vom 20.11.26 12h bis 23.11.26 5h gesperrt"),
          works("full", "Vollsperrung zwischen AS Bramsche und AS Neuenkirchen"),
          works("carriageway", "Richtungsfahrbahn Dortmund gesperrt"),
          works("closed-carriageway", "Die Fahrbahn in Richtung Köln ist gesperrt."),
          works("sperrung", "Sperrung der Richtungsfahrbahn"),
          works("all-lanes", "alle Fahrstreifen gesperrt"),
          works("no-through", "keine Durchfahrt"),
        ],
      },
    }),
    { roadId: "A1" },
  );
  assert.deepEqual(answer.blocking.map((i) => i.identifier), ["full", "carriageway", "closed-carriageway", "sperrung", "all-lanes", "no-through"]);
});

test("checkRoad: an item in both the warnings and the closures listing is counted and listed once", async () => {
  const dup = item("dup1", { display_type: "CLOSURE", description: ["Vollsperrung"] });
  const answer = await checkRoad(client({ A1: { warning: [dup], closure: [dup, item("other", { display_type: "CLOSURE" })] } }), { roadId: "A1" });
  assert.equal(answer.counts.closures, 2);
  assert.equal(answer.counts.warnings, 0);
  assert.deepEqual(answer.blocking.map((i) => i.identifier), ["dup1", "other"]);
});
