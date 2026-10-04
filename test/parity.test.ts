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
    assert.equal(cli.code, 2, label);
    assert.deepEqual(cli.requests, [], label);
    assert.equal(lib.ok, false, label);
    assert.deepEqual(lib.requests, [], label);
    assert.equal(lib.error?.name, "AutobahnValidationError", label);
    assert.equal(lib.error?.message, `Invalid option baseUrl: ${cliReason(cli.err)}`, label);
  }
});

test("parity: a blank, dot or slash road id or identifier is rejected by CLI and library with the same reason", async () => {
  for (const id of ["", "  ", ".", " .. ", "A1/../A2", "A2/"]) {
    for (const [argv, call, name] of [
      [["roadworks", "list", id], (c: AutobahnClient) => c.roadworks.list(id), "roadId"],
      [["roadworks", "get", id], (c: AutobahnClient) => c.roadworks.get(id), "identifier"],
    ] as const) {
      const { cli, lib } = await parity(
        ["--compact", ...argv],
        (transport) => call(new AutobahnClient({ transport })),
        () => jsonResponse({ roadworks: [{ identifier: "a" }], identifier: "a" }),
      );
      const label = `${name}=${JSON.stringify(id)}`;
      assert.equal(cli.code, 2, label);
      assert.deepEqual(cli.requests, [], label);
      assert.equal(lib.ok, false, label);
      assert.deepEqual(lib.requests, [], label);
      assert.equal(lib.error?.name, "AutobahnValidationError", label);
      const cliArgReason = new RegExp(`is invalid for argument '${name}'\\. (.*)$`, "m").exec(cli.err)?.[1];
      assert.equal(lib.error?.message, `Invalid ${name}: ${cliArgReason}`, label);
    }
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
    assert.equal(cli.code, 2, label);
    assert.deepEqual(cli.requests, [], label);
    assert.equal(lib.ok, false, label);
    assert.deepEqual(lib.requests, [], label);
    assert.equal(lib.error?.name, "AutobahnValidationError", label);
    assert.equal(lib.error?.message, `Invalid option baseUrl: ${cliReason(cli.err)}`, label);
    assert.doesNotMatch(cli.err, /s3cret/, label);
    assert.doesNotMatch(lib.error?.message ?? "", /s3cret/, label);
  }
});

test("parity: an empty baseUrl or userAgent is rejected by CLI and library alike, not replaced by the default", async () => {
  for (const [flag, option] of [
    ["--base-url", "baseUrl"],
    ["--user-agent", "userAgent"],
  ] as const) {
    for (const value of ["", "  "]) {
      const { cli, lib } = await parity(
        ["--compact", flag, value, "roads"],
        (transport) => new AutobahnClient({ [option]: value, transport }).roads(),
        () => jsonResponse({ roads: ["A1"] }),
      );
      const label = `${option}=${JSON.stringify(value)}`;
      assert.equal(cli.code, 2, label);
      assert.deepEqual(cli.requests, [], label);
      assert.equal(lib.ok, false, label);
      assert.deepEqual(lib.requests, [], label);
      assert.equal(lib.error?.name, "AutobahnValidationError", label);
      assert.equal(lib.error?.message, `Invalid option ${option}: ${cliReason(cli.err)}`, label);
    }
  }
});
