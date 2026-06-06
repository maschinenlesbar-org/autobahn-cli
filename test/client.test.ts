import { test } from "node:test";
import assert from "node:assert/strict";
import { AutobahnClient } from "../src/client/client.js";
import { AutobahnApiError } from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, constantJson } from "./helpers.js";

function clientWith(mt: ReturnType<typeof makeMockTransport>): AutobahnClient {
  return new AutobahnClient({ transport: mt.transport });
}

test("roads() unwraps the roads array", async () => {
  const mt = constantJson({ roads: ["A1", "A2", "A99"] });
  const roads = await clientWith(mt).roads();
  assert.deepEqual(roads, ["A1", "A2", "A99"]);
  assert.equal(new URL(mt.last().url).pathname, "/o/autobahn/");
});

test("roadworks.list builds the right path and unwraps the envelope", async () => {
  const mt = constantJson({ roadworks: [{ identifier: "abc", title: "A1 roadwork" }] });
  const items = await clientWith(mt).roadworks.list("A1");
  assert.equal(items.length, 1);
  assert.equal(items[0]?.identifier, "abc");
  assert.equal(new URL(mt.last().url).pathname, "/o/autobahn/A1/services/roadworks");
});

test("charging.list uses the electric_charging_station service + key", async () => {
  const mt = constantJson({ electric_charging_station: [{ identifier: "x" }] });
  const items = await clientWith(mt).chargingStations.list("A8");
  assert.equal(items.length, 1);
  assert.equal(
    new URL(mt.last().url).pathname,
    "/o/autobahn/A8/services/electric_charging_station",
  );
});

test("warnings.get builds the details path and url-encodes the identifier", async () => {
  const mt = constantJson({ identifier: "abc", title: "x" });
  await clientWith(mt).warnings.get("a/b+c=");
  assert.equal(
    new URL(mt.last().url).pathname,
    "/o/autobahn/details/warning/a%2Fb%2Bc%3D",
  );
});

test("list() tolerates a missing envelope key", async () => {
  const mt = constantJson({});
  const items = await clientWith(mt).closures.list("A2");
  assert.deepEqual(items, []);
});

test("a 404 raises AutobahnApiError with status 404", async () => {
  const mt = makeMockTransport(() => jsonResponse({ detail: "not found" }, 404));
  await assert.rejects(
    () => clientWith(mt).roadworks.get("nope"),
    (err) => err instanceof AutobahnApiError && err.status === 404,
  );
});
