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

test("parity: roads returns the same trimmed, de-duplicated list from CLI and library", async () => {
  for (const roads of [
    ["A1", "A60", "A60 ", "A7"],
    [" A2", "A2", "", " ", "\tA3\n", "A3"],
  ]) {
    const { cli, lib } = await parity(
      ["--compact", "roads"],
      (transport) => new AutobahnClient({ transport }).roads(),
      () => jsonResponse({ roads }),
    );
    const label = JSON.stringify(roads);
    assert.equal(cli.code, 0, label);
    assert.equal(lib.ok, true, label);
    assert.deepEqual(JSON.parse(cli.out), lib.value, label);
    assert.deepEqual(
      cli.requests.map((r) => r.url),
      lib.requests.map((r) => r.url),
      label,
    );
  }
});

test("parity: CLI and library reject a bad base URL with the same reason, and neither repeats its credentials", async () => {
  for (const baseUrl of [
    "ftp://user:s3cret@h.example",
    "not a url",
    "https://user:s3cret@h.example/?q=1",
    "file:///etc",
    "https://user:s3cret@h.example/a\tb",
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
    assert.doesNotMatch(cli.err, /s3cret/, label);
    assert.doesNotMatch(lib.error?.message ?? "", /s3cret/, label);
  }
});
