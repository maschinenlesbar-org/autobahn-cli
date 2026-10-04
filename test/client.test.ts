import { test } from "node:test";
import assert from "node:assert/strict";
import { AutobahnClient } from "../src/client/client.js";
import {
  AutobahnApiError,
  AutobahnError,
  AutobahnNetworkError,
  AutobahnNotFoundError,
  AutobahnParseError,
  AutobahnValidationError,
} from "../src/client/errors.js";
import type { AutobahnServiceItem } from "../src/client/types.js";
import { makeMockTransport, jsonResponse, constantJson } from "./helpers.js";

function clientWith(mt: ReturnType<typeof makeMockTransport>): AutobahnClient {
  return new AutobahnClient({ transport: mt.transport });
}

test("roads() trims ids, drops blank ones and removes duplicates, keeping the API's order", async () => {
  // Live on 2026-09-15 the API listed both "A60" and "A60 ".
  for (const [served, expected] of [
    [["A6", "A60", "A60 ", " A61", "A61"], ["A6", "A60", "A61"]],
    [[" A2", "A2", "", " ", "\tA3\n", "A3", "A2"], ["A2", "A3"]],
    [[], []],
  ] as const) {
    const roads = await clientWith(constantJson({ roads: served })).roads();
    assert.deepEqual(roads, expected, JSON.stringify(served));
  }
});

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
  await clientWith(mt).warnings.get("a b+c=");
  assert.equal(
    new URL(mt.last().url).pathname,
    "/o/autobahn/details/warning/a%20b%2Bc%3D",
  );
});

test("get() trims surrounding whitespace from the identifier, like list() does for road ids", async () => {
  for (const id of [" DE-BY-000131", "DE-BY-000131 ", "\tDE-BY-000131\n"]) {
    const mt = constantJson({ identifier: "DE-BY-000131" });
    await clientWith(mt).parkingLorries.get(id);
    assert.equal(new URL(mt.last().url).pathname, "/o/autobahn/details/parking_lorry/DE-BY-000131", JSON.stringify(id));
  }
});

test("list() items type each coordinate shape the API returns", async () => {
  // Shapes seen live on 2026-09-15: parking gives a GeoJSON Point and no point
  // string, warnings give numbers, charging gives strings.
  const parking = await clientWith(
    constantJson({
      parking_lorry: [
        { identifier: "DE-SL-000031", point: null, coordinate: { type: "Point", coordinates: [6.373376, 49.483848] } },
      ],
    }),
  ).parkingLorries.list("A8");
  const p = parking[0]?.coordinate;
  assert.ok(p && "coordinates" in p);
  assert.deepEqual(p.coordinates, [6.373376, 49.483848]);
  assert.equal(parking[0]?.point, null);

  const warnings = await clientWith(
    constantJson({ warning: [{ identifier: "w1", coordinate: { lat: 49.45, long: 6.51 } }] }),
  ).warnings.list("A8");
  const w = warnings[0]?.coordinate;
  assert.ok(w && "lat" in w);
  assert.equal(w.lat, 49.45);

  const charging = await clientWith(
    constantJson({ electric_charging_station: [{ identifier: "30388", coordinate: { lat: "54.6", long: "9.44" } }] }),
  ).chargingStations.list("A7");
  const c = charging[0]?.coordinate;
  assert.ok(c && "long" in c);
  assert.equal(Number(c.long), 9.44);
});

/** Answers the road list at /o/autobahn/ and `listing` everywhere else. */
function roadsAnd(listing: unknown, roads: string[] = ["A1", "A2", "A60 ", "A64a"]) {
  return makeMockTransport((req) =>
    new URL(req.url).pathname === "/o/autobahn/" ? jsonResponse({ roads }) : jsonResponse(listing),
  );
}

test("list() returns an empty envelope array as [] for a known road", async () => {
  for (const road of ["A2", "A60", " A64a "]) {
    const mt = roadsAnd({ closure: [] });
    const items = await clientWith(mt).closures.list(road);
    assert.deepEqual(items, [], road);
    // The empty listing is checked against the road list: one extra request.
    assert.equal(mt.calls.length, 2, road);
  }
});

test("an empty listing for a road id the API does not know raises AutobahnNotFoundError, not []", async () => {
  for (const [road, message] of [
    ["a1", 'Unknown road id "a1": not in the API\'s road list (did you mean "A1"?).'],
    ["a64A", 'Unknown road id "a64A": not in the API\'s road list (did you mean "A64a"?).'],
    ["A999", 'Unknown road id "A999": not in the API\'s road list.'],
  ] as const) {
    const mt = roadsAnd({ warning: [] });
    await assert.rejects(
      () => clientWith(mt).warnings.list(road),
      (err: unknown) => err instanceof AutobahnNotFoundError && err.message === message,
      road,
    );
  }
});

test("a failing road-list check after an empty listing names the check, not just the road list endpoint", async () => {
  const cases: Array<[unknown, number, (cause: unknown) => boolean, string]> = [
    [{ message: "maintenance" }, 503, (c) => c instanceof AutobahnApiError && c.status === 503, "HTTP 503 for GET https://verkehr.autobahn.de/o/autobahn/: maintenance"],
    [{ roads: ["A1", null] }, 200, (c) => c instanceof AutobahnParseError, "Unexpected response shape from /o/autobahn/: expected a JSON object with a roads array of strings."],
  ];
  for (const [roadsBody, status, isCause, reason] of cases) {
    const mt = makeMockTransport((req) =>
      new URL(req.url).pathname === "/o/autobahn/" ? jsonResponse(roadsBody, status) : jsonResponse({ roadworks: [] }),
    );
    const client = new AutobahnClient({ transport: mt.transport, sleep: async () => {} });
    await assert.rejects(
      () => client.roadworks.list("A1"),
      (err: unknown) => {
        assert.ok(err instanceof AutobahnError);
        assert.equal(err.constructor, AutobahnError); // not a 404/not-found, not the road list's own class
        assert.equal(
          err.message,
          `Could not check road id "A1" against the API's road list (the roadworks listing was empty): ${reason}`,
        );
        assert.ok(isCause(err.cause));
        return true;
      },
      String(status),
    );
  }
});

test("a listing item that is not an object with a string identifier raises AutobahnParseError", async () => {
  for (const item of [null, 5, "x", [], {}, { identifier: 7 }, { identifier: null }]) {
    await assert.rejects(
      () => clientWith(constantJson({ roadworks: [{ identifier: "ok" }, item] })).roadworks.list("A1"),
      (err: unknown) =>
        err instanceof AutobahnParseError &&
        err.message ===
          "Unexpected response shape from /o/autobahn/A1/services/roadworks: expected every roadworks item to be a JSON object with a string identifier.",
      JSON.stringify(item),
    );
  }
});

test("a non-empty listing is returned without consulting the road list", async () => {
  const mt = roadsAnd({ warning: [{ identifier: "w" }] });
  assert.equal((await clientWith(mt).warnings.list("X9")).length, 1);
  assert.equal(mt.calls.length, 1);
});

test("a 2xx body without the expected envelope raises AutobahnParseError, not []", async () => {
  for (const body of [{}, { closure: "oops", error: "down" }, [1, 2], "hello", null, { closures: [] }]) {
    await assert.rejects(
      () => clientWith(constantJson(body)).closures.list("A2"),
      (err: unknown) =>
        err instanceof AutobahnParseError &&
        err.message ===
          "Unexpected response shape from /o/autobahn/A2/services/closure: expected a JSON object with a closure array.",
      JSON.stringify(body),
    );
  }
  for (const body of [{}, { roads: "A1" }, [1, 2], "hello", null, { roads: [null, 5, "A1"] }]) {
    await assert.rejects(
      () => clientWith(constantJson(body)).roads(),
      (err: unknown) =>
        err instanceof AutobahnParseError &&
        err.message === "Unexpected response shape from /o/autobahn/: expected a JSON object with a roads array of strings.",
      JSON.stringify(body),
    );
  }
});

test("a 404 raises AutobahnApiError with status 404", async () => {
  const mt = makeMockTransport(() => jsonResponse({ detail: "not found" }, 404));
  await assert.rejects(
    () => clientWith(mt).roadworks.get("nope"),
    (err) => err instanceof AutobahnApiError && err.status === 404,
  );
});

test("a client with a file: base URL throws before its custom transport sees a request", () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  assert.throws(
    () => new AutobahnClient({ baseUrl: "file:///etc/passwd", transport: mt.transport }),
    (err: unknown) => err instanceof AutobahnError && !(err instanceof AutobahnNetworkError),
  );
  assert.equal(mt.calls.length, 0);
});

// ---- Dot segments ----

test("a road id or identifier of . or .. is rejected before any request instead of re-targeting the URL", async () => {
  for (const [name, call] of [
    ["roadworks.list ..", (c: AutobahnClient) => c.roadworks.list("..")],
    ["warnings.list .", (c: AutobahnClient) => c.warnings.list(" . ")],
    ["roadworks.get ..", (c: AutobahnClient) => c.roadworks.get("..")],
    ["chargingStations.get .", (c: AutobahnClient) => c.chargingStations.get(".")],
  ] as const) {
    const mt = constantJson({ roadworks: [], warning: [] });
    await assert.rejects(() => call(clientWith(mt)), (err: unknown) => {
      assert.ok(err instanceof AutobahnError, name);
      assert.match(
        (err as Error).message,
        /^Invalid path segment "\.\.?" in \/o\/autobahn\/\S+: "\." and "\.\." cannot be used as an id\.$/,
        name,
      );
      return true;
    });
    assert.equal(mt.calls.length, 0, name);
  }
});

test("a road id containing / is rejected before any request instead of re-targeting the road", async () => {
  for (const roadId of ["A1/../A2", "A2/", "/A1", "A1/x"]) {
    const mt = constantJson({ roadworks: [{ identifier: "a" }] });
    await assert.rejects(() => clientWith(mt).roadworks.list(roadId), (err: unknown) => {
      assert.ok(err instanceof AutobahnValidationError, roadId);
      assert.equal(
        (err as Error).message,
        'Invalid roadId: An id cannot contain "/": the API reads it as a path separator.',
        roadId,
      );
      return true;
    });
    assert.equal(mt.calls.length, 0, roadId);
  }
});

test("an identifier containing / is rejected before any request instead of re-targeting the item", async () => {
  for (const identifier of ["x/../2026-1.de1", "2026-1.de1/", "a/b"]) {
    const mt = constantJson({ identifier: "2026-1.de1" });
    await assert.rejects(() => clientWith(mt).roadworks.get(identifier), (err: unknown) => {
      assert.ok(err instanceof AutobahnValidationError, identifier);
      assert.equal(
        (err as Error).message,
        'Invalid identifier: An id cannot contain "/": the API reads it as a path separator.',
        identifier,
      );
      return true;
    });
    assert.equal(mt.calls.length, 0, identifier);
  }
});

test("ids that merely contain dots are still encoded and sent", async () => {
  const mt = constantJson({ identifier: "x" });
  await clientWith(mt).roadworks.get("2026-1.2.3");
  await clientWith(mt).roadworks.get("...");
  await clientWith(mt).roadworks.get("%2e%2e");
  assert.equal(new URL(mt.calls[0]!.url).pathname, "/o/autobahn/details/roadworks/2026-1.2.3");
  assert.equal(new URL(mt.calls[1]!.url).pathname, "/o/autobahn/details/roadworks/...");
  assert.equal(new URL(mt.calls[2]!.url).pathname, "/o/autobahn/details/roadworks/%252e%252e");
});

test("get() raises AutobahnParseError for a 2xx body that is not a JSON object", async () => {
  for (const body of [null, [1], "x", 5]) {
    await assert.rejects(
      () => clientWith(constantJson(body)).parkingLorries.get("DE-SL-000009"),
      (err: unknown) =>
        err instanceof AutobahnParseError &&
        err.message ===
          "Unexpected response shape from /o/autobahn/details/parking_lorry/DE-SL-000009: expected a JSON object.",
      JSON.stringify(body),
    );
  }
});

test("numeric engine options must be integers in range; a bad one throws instead of disabling a limit", () => {
  const bad: [string, number][] = [
    ["timeoutMs", -1],
    ["timeoutMs", Number.NaN],
    ["timeoutMs", 1.5],
    ["timeoutMs", 2_147_483_648],
    ["maxRetries", -1],
    ["maxRetries", Number.POSITIVE_INFINITY],
    ["maxRetries", Number.NaN],
    ["maxRetries", 11],
    ["retryDelayMs", -1],
    ["retryDelayMs", 30_001],
    ["maxResponseBytes", -1],
    ["maxResponseBytes", 0.5],
  ];
  for (const [name, value] of bad) {
    assert.throws(
      () => new AutobahnClient({ [name]: value }),
      (e: unknown) =>
        e instanceof AutobahnError &&
        new RegExp(`^Invalid option ${name}: expected an integer from 0 to \\d+, got `).test(e.message),
      `${name}=${value}`,
    );
  }
  for (const [name, value] of [
    ["timeoutMs", 0],
    ["timeoutMs", 2_147_483_647],
    ["maxRetries", 10],
    ["retryDelayMs", 0],
    ["maxResponseBytes", 0],
  ] as const) {
    assert.doesNotThrow(() => new AutobahnClient({ [name]: value }), `${name}=${value}`);
  }
});

test("every input the library rejects before a request is an AutobahnValidationError", async () => {
  const mt = constantJson({ roadworks: [] });
  const client = clientWith(mt);
  for (const [label, call] of [
    ["blank roadId", () => client.roadworks.list("  ")],
    ["non-string roadId", () => client.roadworks.list(42 as unknown as string)],
    ["blank identifier", () => client.roadworks.get("")],
    ["dot roadId", () => client.roadworks.list("..")],
    ["dot identifier", () => client.roadworks.get(".")],
    ["timeoutMs -1", async () => new AutobahnClient({ timeoutMs: -1 })],
    ["retryDelayMs 1.5", async () => new AutobahnClient({ retryDelayMs: 1.5 })],
    ["maxRetries 11", async () => new AutobahnClient({ maxRetries: 11 })],
    ["maxResponseBytes NaN", async () => new AutobahnClient({ maxResponseBytes: Number.NaN })],
  ] as const) {
    await assert.rejects(call, AutobahnValidationError, label);
  }
  assert.equal(mt.calls.length, 0);
});

test("startTimestamp is typed to allow the null that lorry parking returns", async () => {
  // Live on 2026-09-26: `parking get DE-SL-000009` carried "startTimestamp": null.
  const items = await clientWith(
    constantJson({ parking_lorry: [{ identifier: "DE-SL-000009", startTimestamp: null }] }),
  ).parkingLorries.list("A1");
  // Compile-time check: this assignment did not type-check while the field was `string`.
  const item: AutobahnServiceItem = { identifier: "DE-SL-000009", startTimestamp: null };
  assert.equal(items[0]?.startTimestamp, item.startTimestamp);
});
