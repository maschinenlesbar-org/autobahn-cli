// CLI <-> library parity: the same input through run() and through the library must
// give the same outcome (both reject without a request, or both send the same requests).

import { test } from "node:test";
import assert from "node:assert/strict";
import { AutobahnClient } from "../src/client/client.js";
import { jsonResponse, parity } from "./helpers.js";

/** The reason commander appends to `error: option '...' argument '...' is invalid.` */
function cliReason(err: string): string | undefined {
  return /is invalid\. (.*)$/m.exec(err)?.[1];
}

test("parity: a base URL with surrounding whitespace is rejected by CLI and library alike", async () => {
  const NBSP = String.fromCharCode(0xa0);
  for (const baseUrl of [
    "https://h.example/ ",
    "https://h.example ",
    " https://h.example",
    "\thttp://h",
    "https://h.example\n",
    "http://h/base ",
    `https://h.example/${NBSP}`,
  ]) {
    const { cli, lib } = await parity(
      ["--compact", "--base-url", baseUrl, "roads"],
      (transport) => new AutobahnClient({ baseUrl, transport }).roads(),
      () => jsonResponse({ roads: ["A1"] }),
    );
    const label = JSON.stringify(baseUrl);
    assert.equal(cli.code, 1, label);
    assert.deepEqual(cli.requests, [], label);
    assert.equal(lib.ok, false, label);
    assert.deepEqual(lib.requests, [], label);
    assert.equal(lib.error?.name, "AutobahnValidationError", label);
    assert.equal(lib.error?.message, `Invalid option baseUrl: ${cliReason(cli.err)}`, label);
  }
});
