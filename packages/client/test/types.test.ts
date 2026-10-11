// Compile-time checks of the exported library types; the runtime assertions are trivial.

import { test } from "node:test";
import assert from "node:assert/strict";
import { AutobahnClient, type ServiceResource } from "../src/index.js";
import { constantJson } from "./helpers.js";

test("ServiceResource names the type of any service resource", async () => {
  const count = async (resource: ServiceResource<string>, road: string): Promise<number> =>
    (await resource.list(road)).length;
  const client = new AutobahnClient({ transport: constantJson({ roadworks: [{ identifier: "a" }] }).transport });
  assert.equal(await count(client.roadworks, "A1"), 1);
});
