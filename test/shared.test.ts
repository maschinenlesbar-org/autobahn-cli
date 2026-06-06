import { test } from "node:test";
import assert from "node:assert/strict";
import { InvalidArgumentError } from "commander";
import { parseIntArg, toEngineOptions } from "../src/cli/shared.js";

test("parseIntArg accepts plain non-negative decimal integers", () => {
  assert.equal(parseIntArg("0"), 0);
  assert.equal(parseIntArg("42"), 42);
  assert.equal(parseIntArg("1000"), 1000);
});

test("parseIntArg rejects the empty string", () => {
  assert.throws(() => parseIntArg(""), InvalidArgumentError);
});

test("parseIntArg rejects surrounding whitespace", () => {
  assert.throws(() => parseIntArg(" 5"), InvalidArgumentError);
  assert.throws(() => parseIntArg("5 "), InvalidArgumentError);
  assert.throws(() => parseIntArg("\t5"), InvalidArgumentError);
});

test("parseIntArg rejects hex and binary forms", () => {
  assert.throws(() => parseIntArg("0x10"), InvalidArgumentError);
  assert.throws(() => parseIntArg("0b1"), InvalidArgumentError);
});

test("parseIntArg rejects exponent and float forms", () => {
  assert.throws(() => parseIntArg("1e3"), InvalidArgumentError);
  assert.throws(() => parseIntArg("1.5"), InvalidArgumentError);
});

test("parseIntArg rejects negatives and non-numbers", () => {
  assert.throws(() => parseIntArg("-5"), InvalidArgumentError);
  assert.throws(() => parseIntArg("abc"), InvalidArgumentError);
  assert.throws(() => parseIntArg("+5"), InvalidArgumentError);
});

test("parseIntArg rejects integers beyond the safe range", () => {
  assert.throws(() => parseIntArg("99999999999999999999"), InvalidArgumentError);
});

test("toEngineOptions maps only the options that are present", () => {
  assert.deepEqual(toEngineOptions({}), {});
  assert.deepEqual(
    toEngineOptions({
      baseUrl: "https://example.test",
      timeout: 1000,
      userAgent: "ua/1",
      maxRetries: 3,
      maxResponseBytes: 2048,
      compact: true,
    }),
    {
      baseUrl: "https://example.test",
      timeoutMs: 1000,
      userAgent: "ua/1",
      maxRetries: 3,
      maxResponseBytes: 2048,
    },
  );
});

test("toEngineOptions preserves an explicit zero", () => {
  assert.deepEqual(toEngineOptions({ timeout: 0, maxResponseBytes: 0 }), {
    timeoutMs: 0,
    maxResponseBytes: 0,
  });
});
