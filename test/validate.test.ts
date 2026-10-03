import { test } from "node:test";
import assert from "node:assert/strict";
import { assertValid, baseUrlProblem, type Problem } from "../src/client/validate.js";
import { AutobahnError, AutobahnValidationError } from "../src/client/errors.js";
import * as library from "../src/index.js";
import { AutobahnClient } from "../src/client/client.js";
import { jsonResponse, parity } from "./helpers.js";

const nonEmpty: Problem = (value) => (value.trim() === "" ? "Expected a non-empty value." : undefined);

test("assertValid returns a valid value unchanged", () => {
  assert.equal(assertValid("name", "x", nonEmpty), "x");
});

test("assertValid throws AutobahnValidationError with 'Invalid <name>: <reason>'", () => {
  assert.throws(
    () => assertValid("roadId", " ", nonEmpty),
    (err: unknown) =>
      err instanceof AutobahnValidationError &&
      err instanceof AutobahnError &&
      err.name === "AutobahnValidationError" &&
      err.message === "Invalid roadId: Expected a non-empty value.",
  );
});

test("assertValid inside an async method rejects instead of throwing synchronously", async () => {
  const method = async (value: string): Promise<string> => assertValid("q", value, nonEmpty);
  const pending = method("");
  assert.ok(pending instanceof Promise);
  await assert.rejects(pending, AutobahnValidationError);
});

test("the library root exports the validation layer", () => {
  assert.equal(library.AutobahnValidationError, AutobahnValidationError);
  assert.equal(library.assertValid, assertValid);
});

test("parity() runs one input through run() and the library on recording transports", async () => {
  const { cli, lib } = await parity(
    ["--compact", "roads"],
    (transport) => new AutobahnClient({ transport }).roads(),
    () => jsonResponse({ roads: ["A1"] }),
  );
  assert.equal(cli.code, 0);
  assert.equal(cli.out, '["A1"]');
  assert.deepEqual(lib, { ok: true, value: ["A1"], requests: lib.requests });
  assert.deepEqual(
    cli.requests.map((r) => r.url),
    lib.requests.map((r) => r.url),
  );

  const failing = await parity(["roads"], () => {
    throw new AutobahnValidationError("Invalid x: y");
  });
  assert.deepEqual(failing.lib, {
    ok: false,
    error: { name: "AutobahnValidationError", message: "Invalid x: y" },
    requests: [],
  });
});

test("baseUrlProblem accepts http(s) URLs, with or without a path prefix or trailing slash", () => {
  for (const value of [
    "https://verkehr.autobahn.de",
    "http://127.0.0.1:8080/",
    "https://mirror.example/autobahn/",
    "https://user:pw@h.example/a b",
  ]) {
    assert.equal(baseUrlProblem(value), undefined, value);
  }
});

test("baseUrlProblem names the reason without repeating the value", () => {
  for (const [value, reason] of [
    ["", "Expected an absolute http(s) URL."],
    ["  ", "Expected an absolute http(s) URL."],
    ["not a url", "Expected an absolute http(s) URL."],
    ["ftp://user:s3cret@h.example", 'Unsupported scheme "ftp:". Expected an http(s) URL.'],
    ["file:///etc", 'Unsupported scheme "file:". Expected an http(s) URL.'],
    ["https://h.example/?q=1", "A base URL cannot have a query (?) or fragment (#)."],
    ["https://h.example/#f", "A base URL cannot have a query (?) or fragment (#)."],
    ["https://h.example/ ", "A base URL cannot have surrounding whitespace."],
    [" https://h.example", "A base URL cannot have surrounding whitespace."],
    ["\thttp://h", "A base URL cannot have surrounding whitespace."],
    ["https://h.example\n", "A base URL cannot have surrounding whitespace."],
    ["https://h.example/\u00a0", "A base URL cannot have surrounding whitespace."],
    ["https://h.exa\tmple", "A base URL cannot contain control characters."],
    ["https://h.example/a\u007fb", "A base URL cannot contain control characters."],
  ] as const) {
    assert.equal(baseUrlProblem(value), reason, JSON.stringify(value));
  }
});
