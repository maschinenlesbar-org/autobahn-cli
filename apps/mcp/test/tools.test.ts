// This server's tools against a mock of the Autobahn API, with the skills' traps as cases: a
// ramp closure never shuts the road, an accident warning counts whatever its delay, an unknown
// road id is an error with a did-you-mean (never an all-clear), charging positions come from
// both coordinate shapes and never print "undefined" as a direction.

import { test } from "node:test";
import assert from "node:assert/strict";
import { listTools } from "../src/mcp/server.js";
import { connect } from "./harness.js";
import { autobahn, warning } from "./helpers.js";

const world = autobahn({
  A1: {
    warning: [
      warning("w-slow", { delayTimeValue: "5", abnormalTrafficType: "SLOW_TRAFFIC" }),
      warning("w-jam", { delayTimeValue: "37", abnormalTrafficType: "QUEUING_TRAFFIC" }),
      warning("w-crash", { description: ["Unfall, seit 19.11.2026", "Beginn: 19.11.26 um 09:00 Uhr"] }),
    ],
    closure: [
      { identifier: "c-ramp", title: "A1 | AS Köln-Nord", display_type: "CLOSURE_ENTRY_EXIT", isBlocked: "false", future: false, description: ["Vollsperrung der Ausfahrt"] },
      { identifier: "c-full", title: "A1 | Köln - Leverkusen", display_type: "CLOSURE", isBlocked: "false", future: false, description: ["Vollsperrung in Fahrtrichtung Dortmund"] },
      { identifier: "c-later", title: "A1 | Leverkusen", display_type: "CLOSURE", isBlocked: "false", future: true, description: ["Vollsperrung"] },
    ],
    roadworks: [{ identifier: "r1", title: "A1 | Bauarbeiten", display_type: "ROADWORKS", isBlocked: "false", future: false, description: ["Fahrstreifen verengt"] }],
    electric_charging_station: [
      { identifier: "30388", title: "A1 | undefined | Sophienberg W", coordinate: { type: "Point", coordinates: [7.0, 50.0] }, description: ["4 Ladepunkte", "DC Kupplung Combo (CCS)", "200+kW", "Ladesäulenbetreiber: Ionity"] },
      { identifier: "RUxF", title: "A1 | Bremen | Nord West", coordinate: { lat: "53.0", long: "8.0" }, description: ["Nord West", "Ladepunkt 1:", "DC Kupplung Combo", "50 kW", "Ladepunkt 2:", "AC Kupplung Typ 2", "22 kW"] },
      { identifier: "RUxG", title: "A1 | Köln | Lost", description: ["Ladepunkt 1:", "50 kW"] },
    ],
  },
  A7: {},
});

test("five tools: the use cases first, then the generic ones", () => {
  assert.deepEqual(listTools().map((t) => t.name), ["checkRoad", "findChargingStations", "listRoads", "listServiceItems", "getServiceItem"]);
});

test("checkRoad: blocking closures, hazards and the worst delays; ramp and planned closures never block", async () => {
  const connection = await connect({ transport: world });
  const result = await connection.call("checkRoad", { roadId: "A1" });
  const answer = result.structuredContent as Record<string, unknown>;
  assert.equal(answer["status"], "ok", result.content[0]?.text);
  assert.deepEqual(answer["counts"], { warnings: 3, closures: 2, rampClosures: 1, roadworks: 1, planned: 1 });
  assert.deepEqual((answer["blocking"] as { identifier: string }[]).map((i) => i.identifier), ["c-full"]);
  assert.deepEqual((answer["hazards"] as { identifier: string }[]).map((i) => i.identifier), ["w-crash"]);
  assert.deepEqual((answer["worstDelays"] as { identifier: string; delayMinutes: number }[]).map((i) => [i.identifier, i.delayMinutes]), [["w-jam", 37], ["w-slow", 5]]);
  assert.match(String(answer["source"]), /\/o\/autobahn\/A1\/services$/);
  await connection.close();
});

test("checkRoad: an unknown or wrong-case road id is an error with a did-you-mean, never an all-clear", async () => {
  const connection = await connect({ transport: world });
  const result = await connection.call("checkRoad", { roadId: "a1" });
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /Unknown road id "a1".*did you mean "A1"/);
  await connection.close();
});

test("findChargingStations: road order from both coordinate shapes, power from the description, no 'undefined' direction", async () => {
  const connection = await connect({ transport: world });
  const result = await connection.call("findChargingStations", { roadId: "A1" });
  const answer = result.structuredContent as { stations: Record<string, unknown>[]; orderedBy: string; withoutPosition: number };
  assert.deepEqual(answer.stations.map((s) => s["identifier"]), ["RUxF", "30388", "RUxG"]);
  assert.equal(answer.orderedBy, "latitude");
  assert.equal(answer.withoutPosition, 1);
  const dn = answer.stations[1] as Record<string, unknown>;
  assert.deepEqual(dn["position"], [50, 7]);
  assert.equal(dn["maxKw"], 200);
  assert.equal(dn["points"], 4);
  assert.equal(dn["operator"], "Ionity");
  assert.equal(dn["towards"], undefined);
  assert.deepEqual([answer.stations[0]?.["towards"], answer.stations[0]?.["maxKw"], answer.stations[0]?.["points"]], ["Bremen", 50, 2]);
  await connection.close();
});

test("findChargingStations: minKw keeps the fast sites; none fast enough is empty with a reason", async () => {
  const connection = await connect({ transport: world });
  const fast = await connection.call("findChargingStations", { roadId: "A1", minKw: 150 });
  assert.deepEqual((fast.structuredContent?.["stations"] as { identifier: string }[]).map((s) => s.identifier), ["30388"]);
  const none = await connection.call("findChargingStations", { roadId: "A1", minKw: 400 });
  assert.equal(none.structuredContent?.["status"], "empty");
  assert.match(String(none.structuredContent?.["reason"]), /None of the 3 sites on A1 reaches 400 kW/);
  await connection.close();
});

test("listRoads, listServiceItems (paged) and getServiceItem", async () => {
  const connection = await connect({ transport: world });
  const roads = await connection.call("listRoads", {});
  assert.deepEqual(roads.structuredContent?.["roads"], ["A1", "A7"]);
  const page = await connection.call("listServiceItems", { service: "warnings", roadId: "A1", limit: 2 });
  assert.equal(page.structuredContent?.["total"], 3);
  assert.equal(page.structuredContent?.["nextOffset"], 2);
  const item = await connection.call("getServiceItem", { service: "closures", identifier: "c-full" });
  assert.equal((item.structuredContent?.["item"] as { identifier: string }).identifier, "c-full");
  assert.match(String(item.structuredContent?.["source"]), /\/o\/autobahn\/details\/closure\/c-full$/);
  await connection.close();
});

test("listServiceItems: a known road without items is empty with a reason", async () => {
  const connection = await connect({ transport: world });
  const result = await connection.call("listServiceItems", { service: "webcams", roadId: "A7" });
  assert.equal(result.structuredContent?.["status"], "empty");
  assert.match(String(result.structuredContent?.["reason"]), /No webcams are listed on A7/);
  await connection.close();
});

test("listServiceItems: an offset at or past the end is empty with a reason, not ok with no items", async () => {
  const connection = await connect({ transport: world });
  for (const offset of [3, 100_000]) {
    const result = await connection.call("listServiceItems", { service: "warnings", roadId: "A1", offset });
    assert.equal(result.structuredContent?.["status"], "empty", result.content[0]?.text);
    assert.equal(result.structuredContent?.["total"], 3);
    assert.deepEqual(result.structuredContent?.["items"], []);
    assert.match(String(result.structuredContent?.["reason"]), new RegExp(`offset ${offset} is past the end: A1 lists 3 warnings \\(offsets 0 to 2\\)`));
    assert.equal(result.structuredContent?.["nextOffset"], undefined);
  }
  await connection.close();
});
