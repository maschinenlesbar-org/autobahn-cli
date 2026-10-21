import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_USER_AGENT,
  RequestEngine,
  bigIntegerKeysOption,
  firstInexactNumber,
  parseRetryAfter,
  quoteValue,
  sanitizeServerText,
  scanNumbers,
} from "../src/engine.js";
import {
  AutobahnApiError,
  AutobahnNetworkError,
  AutobahnParseError,
  AutobahnValidationError,
  redactUrl,
  cutText,
  toWellFormed,
} from "../src/errors.js";
import type { HttpResponse } from "../src/http.js";
import { makeMockTransport, jsonResponse, rawResponse } from "./helpers.js";

// Control chars are built via char codes so no raw control byte ever appears in
// this source file.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CSI = String.fromCharCode(0x9b); // a C1 control

/** True if the string contains any C0/C1 control char except tab/newline. */
function hasControlChars(s: string): boolean {
  return [...s].some((c) => {
    const n = c.charCodeAt(0);
    return n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f);
  });
}

test("buildUrl normalises the path and appends the query", () => {
  const e = new RequestEngine({ baseUrl: "https://example.test/" });
  assert.equal(e.buildUrl("o/autobahn/"), "https://example.test/o/autobahn/");
  assert.equal(
    e.buildUrl("/x", { a: "1", b: ["2", "3"] }),
    "https://example.test/x?a=1&b=2&b=3",
  );
});

test("the constructor rejects a malformed base URL with a clear, base-only message", () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  assert.throws(
    () => new RequestEngine({ baseUrl: "notaurl", transport: mt.transport }),
    (err: unknown) =>
      err instanceof AutobahnValidationError &&
      !(err instanceof AutobahnNetworkError) &&
      err.message === "Invalid option baseUrl: Expected an absolute http(s) URL.",
  );
  assert.equal(mt.calls.length, 0);
});

test("an empty base URL is rejected, not replaced by the default", () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  assert.throws(
    () => new RequestEngine({ baseUrl: "", transport: mt.transport }),
    (err: unknown) =>
      err instanceof AutobahnValidationError &&
      err.message === "Invalid option baseUrl: Expected an absolute http(s) URL.",
  );
  assert.equal(mt.calls.length, 0);
  assert.equal(new RequestEngine({ baseUrl: undefined }).buildUrl("/x"), "https://verkehr.autobahn.de/x");
});

test("the constructor rejects a non-http(s) base URL before any request", () => {
  for (const bad of ["file:///etc/passwd", "ftp://example.org"]) {
    const mt = makeMockTransport(() => jsonResponse({}));
    assert.throws(
      () => new RequestEngine({ baseUrl: bad, transport: mt.transport }),
      (err: unknown) =>
        err instanceof AutobahnValidationError &&
        !(err instanceof AutobahnNetworkError) &&
        /^Invalid option baseUrl: Unsupported scheme "(file|ftp):"\. Expected an http\(s\) URL\.$/.test(err.message),
      bad,
    );
    assert.equal(mt.calls.length, 0, bad);
  }
});

test("getJson parses a JSON body", async () => {
  const mt = makeMockTransport(() => jsonResponse({ ok: true }));
  const e = new RequestEngine({ transport: mt.transport });
  assert.deepEqual(await e.getJson("/x"), { ok: true });
});

test("getJson throws AutobahnParseError on invalid JSON", async () => {
  const mt = makeMockTransport(() => rawResponse("not json", "application/json"));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(() => e.getJson("/x"), AutobahnParseError);
});

test("a number the JSON cannot carry exactly is a parse error, never a changed value", async () => {
  // JSON.parse rounds 12345678901234567890 (in any form: .0, e0, E-1) and 9007199254740992.5 to the
  // nearest double, turns 1e400 into Infinity (printed as null) and 1e-400 into 0, silently.
  const body = (n: string) => `{"id":"a","n":${n},"text":"12345678901234567890 in a string"}`;
  for (const n of [
    "12345678901234567890", "-9007199254740993", "1e400", "-1E400", "12345678901234567890.0", "9007199254740993e0",
    "90071992547409930E-1", "9007199254740992.5", "-9007199254740992.5", "1e-400", "-0.0001e-399",
    "123456789012345678901234567890",
    // Below the smallest normal double a subnormal has fewer digits: 3e-324 became 5e-324.
    "3e-324", "4e-324", "-4.9e-324", "1.2345678901234567e-310", "2.225073858507201e-309",
  ]) {
    const e = new RequestEngine({ transport: makeMockTransport(() => rawResponse(body(n), "application/json")).transport });
    await assert.rejects(e.getJson("/items/a"), (err: unknown) => {
      assert.ok(err instanceof AutobahnParseError, n);
      assert.equal(err.message, `GET https://verkehr.autobahn.de/items/a: the number ${n} cannot be represented exactly.`);
      return true;
    });
  }
  // What a double carries exactly, or as JSON means it (a decimal fraction below 2^53), passes.
  const exact: Array<[string, number]> = [
    ["9007199254740991", 9007199254740991], ["9007199254740992.0", 2 ** 53], ["9007199254740992e0", 2 ** 53],
    ["90071992547409920E-1", 2 ** 53], ["1e21", 1e21], ["1.2e21", 1.2e21], ["0", 0], ["-0", -0], ["0.0e-500", 0],
    ["1.10", 1.1], ["0.1", 0.1], ["1.00000000000000001", 1], ["5e-324", 5e-324],
    // A double a server printed in its shortest form reads back as that double and prints as the
    // same number: not a changed value, though the decimal is not the double's exact binary value.
    ["1e23", 1e23], ["100000000000000000000000", 1e23], ["1E23", 1e23], ["1.7976931348623157E308", Number.MAX_VALUE], ["-1.7976931348623157e308", -Number.MAX_VALUE],
    ["4.35e30", 4.35e30],
    // A subnormal or the smallest normal double that prints as written.
    ["-5e-324", -5e-324], ["1e-310", 1e-310], ["2.2250738585072014e-308", 2.2250738585072014e-308],
  ];
  for (const [n, value] of exact) {
    const e = new RequestEngine({ transport: makeMockTransport(() => rawResponse(body(n), "application/json")).transport });
    assert.equal((await e.getJson<{ n: number }>("/x")).n, value, n);
  }
});

test("the number check skips strings and costs one pass over the text", async () => {
  // Escaped quotes and backslashes must not end a string early and expose its digits.
  const tricky = `{"id":"a","s":"\\\\\\"12345678901234567890\\\\","t":"1e400","n":[1,2.5,-3e2]}`;
  const e = new RequestEngine({ transport: makeMockTransport(() => rawResponse(tricky, "application/json")).transport });
  assert.deepEqual(await e.getJson("/x"), JSON.parse(tricky));
  // 1 MB of numbers: the scan is linear.
  const big = `[${Array.from({ length: 200_000 }, (_, i) => i * 7).join(",")}]`;
  const f = new RequestEngine({ transport: makeMockTransport(() => rawResponse(big, "application/json")).transport });
  assert.equal((await f.getJson<number[]>("/x")).length, 200_000);
});

test("a 503 is retried up to maxRetries then surfaces as AutobahnApiError", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return jsonResponse({ detail: "busy" }, 503);
  });
  const e = new RequestEngine({
    transport: mt.transport,
    maxRetries: 2,
    sleep: async () => {},
  });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => err instanceof AutobahnApiError && err.status === 503,
  );
  assert.equal(calls, 3); // initial + 2 retries
});

test("the error after the last retry says how many retries were made", async () => {
  for (const [maxRetries, suffix] of [[2, " (after 2 retries)"], [1, " (after 1 retry)"], [0, ""]] as const) {
    const mt = makeMockTransport(() => jsonResponse({ message: "slow down" }, 429));
    const e = new RequestEngine({ transport: mt.transport, maxRetries, sleep: async () => {} });
    await assert.rejects(
      () => e.getJson("/x"),
      (err: unknown) =>
        err instanceof AutobahnApiError &&
        err.retries === maxRetries &&
        err.message === `HTTP 429 for GET https://verkehr.autobahn.de/x: slow down${suffix}`,
      String(maxRetries),
    );
  }
  // A non-retryable status is not retried, so it says nothing about retries.
  const e = new RequestEngine({ transport: makeMockTransport(() => jsonResponse({}, 500)).transport, sleep: async () => {} });
  await assert.rejects(() => e.getJson("/x"), (err: unknown) => err instanceof AutobahnApiError && err.retries === 0 && !/retr/.test(err.message));
});

test("a compressed body names its Content-Encoding instead of failing as non-JSON", async () => {
  const gzip = makeMockTransport(() => ({
    status: 200,
    headers: { "content-type": "application/json", "content-encoding": "gzip" },
    body: Buffer.from([0x1f, 0x8b, 0, 0]),
  }));
  await assert.rejects(
    () => new RequestEngine({ transport: gzip.transport }).getJson("/x"),
    (err: unknown) =>
      err instanceof AutobahnParseError &&
      err.message === 'GET https://verkehr.autobahn.de/x: unsupported Content-Encoding "gzip" (the client does not decompress responses).',
  );
  const identity = makeMockTransport(() => ({
    status: 200,
    headers: { "content-type": "application/json", "content-encoding": "identity" },
    body: Buffer.from('{"ok":1}'),
  }));
  assert.deepEqual(await new RequestEngine({ transport: identity.transport }).getJson("/x"), { ok: 1 });
  for (const value of ["identity, identity", "Identity,", " identity "]) {
    const listed = makeMockTransport(() => ({
      status: 200,
      headers: { "content-type": "application/json", "content-encoding": value },
      body: Buffer.from('{"ok":2}'),
    }));
    assert.deepEqual(await new RequestEngine({ transport: listed.transport }).getJson("/x"), { ok: 2 }, value);
  }
});

test("a non-JSON body names its Content-Type when that is not JSON", async () => {
  for (const [contentType, message] of [
    ["text/html; charset=utf-8", 'GET https://verkehr.autobahn.de/x: the answer is not valid JSON (expected JSON, got Content-Type "text/html").'],
    ["application/json", "GET https://verkehr.autobahn.de/x: the answer is not valid JSON."],
    ["", "GET https://verkehr.autobahn.de/x: the answer is not valid JSON."],
  ] as const) {
    const e = new RequestEngine({ transport: makeMockTransport(() => rawResponse("<html>maintenance</html>", contentType)).transport });
    await assert.rejects(
      () => e.getJson("/x"),
      (err: unknown) => err instanceof AutobahnParseError && err.message === message,
      contentType,
    );
  }
});

test("an error thrown by a custom transport surfaces as AutobahnNetworkError with the cause", async () => {
  const boom = new Error("boom");
  for (const [thrown, message] of [
    [boom, "GET https://verkehr.autobahn.de/x failed: boom"],
    ["plain string", "GET https://verkehr.autobahn.de/x failed: plain string"],
  ] as const) {
    const e = new RequestEngine({ transport: async () => { throw thrown; } });
    await assert.rejects(
      () => e.getJson("/x"),
      (err: unknown) => err instanceof AutobahnNetworkError && err.message === message && err.cause === thrown,
    );
  }
  // A network error from the transport is re-raised naming the request, original as cause.
  const own = new AutobahnNetworkError("Request timed out after 5ms");
  const e = new RequestEngine({ transport: async () => { throw own; } });
  await assert.rejects(
    () => e.getJson("/x"),
    (err: unknown) =>
      err instanceof AutobahnNetworkError &&
      err.cause === own &&
      err.message === "GET https://verkehr.autobahn.de/x failed: Request timed out after 5ms",
  );
  // Any other AutobahnError passes through unchanged.
  const parse = new AutobahnParseError("odd");
  const p = new RequestEngine({ transport: async () => { throw parse; } });
  await assert.rejects(() => p.getJson("/x"), (err: unknown) => err === parse);
});

test("a network error names the request URL (credentials redacted) and the retries made", async () => {
  const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  const e = new RequestEngine({
    baseUrl: "https://user:s3cret@mirror.example/api",
    maxRetries: 2,
    sleep: async () => {},
    transport: async () => { throw new AutobahnNetworkError(reset.message, { cause: reset }); },
  });
  await assert.rejects(
    () => e.getJson("/o/autobahn/"),
    (err: unknown) =>
      err instanceof AutobahnNetworkError &&
      err.message === "GET https://***@mirror.example/api/o/autobahn/ failed: socket hang up (after 2 retries)",
  );
});

test("only GET and HEAD requests are retried", async () => {
  for (const [method, expected] of [["GET", 3], ["HEAD", 3], ["POST", 1], ["DELETE", 1]] as const) {
    let calls = 0;
    const e = new RequestEngine({
      maxRetries: 2,
      sleep: async () => {},
      transport: async () => {
        calls += 1;
        return { status: 503, headers: {}, body: Buffer.alloc(0) };
      },
    });
    await assert.rejects(() => e.request(method, "/x"), AutobahnApiError, method);
    assert.equal(calls, expected, method);
  }
});

test("a timed-out request is not retried", async () => {
  let calls = 0;
  const e = new RequestEngine({
    maxRetries: 2,
    sleep: async () => {},
    transport: async () => {
      calls += 1;
      throw new AutobahnNetworkError("Request timed out after 5ms");
    },
  });
  await assert.rejects(() => e.getJson("/x"), AutobahnNetworkError);
  assert.equal(calls, 1);
});

test("the default User-Agent names the project and its URL (the CLI adds its version)", async () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  await new RequestEngine({ transport: mt.transport }).getJson("/x");
  assert.equal(mt.last().headers?.["User-Agent"], "autobahn-cli (+https://github.com/maschinenlesbar-org/autobahn-cli)");
  assert.equal(DEFAULT_USER_AGENT, mt.last().headers?.["User-Agent"]);
});

test("describeUrl describes any path without validating it", () => {
  const e = new RequestEngine({ baseUrl: "https://h.example/api" });
  assert.equal(e.describeUrl("/o/./x"), "https://h.example/api/o/./x");
  assert.equal(e.describeUrl("o/autobahn/"), "https://h.example/api/o/autobahn/");
  assert.throws(() => e.buildUrl("/o/./x"), AutobahnValidationError);
  // With userinfo the URL is redacted (and so normalised by URL parsing), still no throw.
  const withUser = new RequestEngine({ baseUrl: "https://user:s3cret@h.example/api" });
  assert.equal(withUser.describeUrl("/o/../x"), "https://***@h.example/api/x");
});

test("a fetch Headers object from a custom transport is read like plain headers", async () => {
  let n = 0;
  const slept: number[] = [];
  const e = new RequestEngine({
    maxRetries: 1,
    sleep: async (ms) => void slept.push(ms),
    transport: async () =>
      (++n === 1
        ? { status: 429, headers: new Headers({ "Retry-After": "7" }), body: Buffer.alloc(0) }
        : {
            status: 200,
            headers: new Headers({ "Content-Type": "application/json; charset=iso-8859-1" }),
            body: Buffer.from('{"roads":["A\xfc"]}', "latin1"),
          }) as unknown as HttpResponse,
  });
  assert.deepEqual(await e.getJson("/x"), { roads: ["Aü"] });
  assert.deepEqual(slept, [7000]);
});

test("a Uint8Array body from a custom transport is accepted", async () => {
  const bytes = new TextEncoder().encode('xx{"roads":["A1"]}').subarray(2);
  const e = new RequestEngine({
    transport: async () =>
      ({ status: 200, headers: { "content-type": "application/json" }, body: bytes }) as unknown as HttpResponse,
  });
  assert.deepEqual(await e.getJson("/x"), { roads: ["A1"] });
});

test("upper-case header names from a custom transport are read", async () => {
  const e = new RequestEngine({
    transport: async () => ({
      status: 200,
      headers: { "Content-Type": "application/json; charset=iso-8859-1" },
      body: Buffer.from('{"roads":["A\xfc"]}', "latin1"),
    }),
  });
  assert.deepEqual(await e.getJson("/x"), { roads: ["Aü"] });
});

test("a malformed response from a custom transport is an AutobahnNetworkError, not a TypeError", async () => {
  for (const [response, problem] of [
    [{}, "status is not an HTTP status code"],
    [null, "not an object"],
    [{ status: 200, body: Buffer.from("{}") }, "headers is not an object"],
    [{ status: 200, headers: {}, body: '{"roads":["A1"]}' }, "body is not a Buffer, Uint8Array, other ArrayBuffer view or ArrayBuffer"],
    [{ status: 1000, headers: {}, body: Buffer.alloc(0) }, "status is not an HTTP status code"],
  ] as const) {
    const e = new RequestEngine({ transport: async () => response as unknown as HttpResponse });
    await assert.rejects(
      () => e.getJson("/x"),
      (err: unknown) =>
        err instanceof AutobahnNetworkError &&
        err.message === `GET https://verkehr.autobahn.de/x failed: the transport returned an invalid response (${problem}).`,
      problem,
    );
  }
});

test("null options mean the defaults, like no options", async () => {
  assert.ok(new RequestEngine(null as unknown as undefined) instanceof RequestEngine);
  const { AutobahnClient } = await import("../src/client.js");
  assert.doesNotThrow(() => new AutobahnClient(null as unknown as undefined));
});

test("an unknown option whose value is undefined is ignored", () => {
  assert.doesNotThrow(() => new RequestEngine({ timeoutMs: 1000, proxy: undefined } as unknown as ConstructorParameters<typeof RequestEngine>[0]));
});

test("an unknown option name makes the constructor throw, with a hint when one is close", () => {
  for (const [options, message] of [
    [{ timeout: 1 }, 'Unknown option "timeout" (did you mean timeoutMs?).'],
    [{ retries: 1 }, 'Unknown option "retries" (did you mean maxRetries?).'],
    [{ proxy: "x" }, 'Unknown option "proxy"; the options are baseUrl, transport, userAgent, timeoutMs, maxRetries, retryDelayMs, maxResponseBytes, sleep, onRetry, bigIntegerKeys.'],
  ] as const) {
    assert.throws(
      () => new RequestEngine(options as unknown as ConstructorParameters<typeof RequestEngine>[0]),
      (err: unknown) => err instanceof AutobahnValidationError && err.message === message,
    );
  }
});

test("a transport or sleep that is not a function makes the constructor throw", () => {
  for (const [options, message] of [
    [{ transport: "nope" }, "Invalid option transport: expected a function, got string."],
    [{ sleep: 5 }, "Invalid option sleep: expected a function, got number."],
  ] as const) {
    assert.throws(
      () => new RequestEngine(options as unknown as ConstructorParameters<typeof RequestEngine>[0]),
      (err: unknown) => err instanceof AutobahnValidationError && err.message === message,
    );
  }
});

test("a retried request that then succeeds resolves", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return calls === 1 ? jsonResponse({}, 503) : jsonResponse({ ok: 1 });
  });
  const e = new RequestEngine({ transport: mt.transport, sleep: async () => {} });
  assert.deepEqual(await e.getJson("/x"), { ok: 1 });
  assert.equal(calls, 2);
});

test("getJson drops a leading BOM and decodes by the Content-Type charset", async () => {
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"roads":["A1"]}')]);
  const e1 = new RequestEngine({ transport: makeMockTransport(() => rawResponse(bom, "application/json")).transport });
  assert.deepEqual(await e1.getJson("/x"), { roads: ["A1"] });

  const latin1 = Buffer.from('{"t":"Gr\u00f6\u00dfe"}', "latin1");
  const e2 = new RequestEngine({
    transport: makeMockTransport(() => rawResponse(latin1, "application/json; charset=ISO-8859-1")).transport,
  });
  assert.deepEqual(await e2.getJson("/x"), { t: "Größe" });

  const e3 = new RequestEngine({
    transport: makeMockTransport(() => rawResponse("{}", 'application/json; charset="x-bogus"')).transport,
  });
  await assert.rejects(
    () => e3.getJson("/x"),
    (err: unknown) => err instanceof AutobahnParseError && err.message === 'GET https://verkehr.autobahn.de/x: unsupported response charset "x-bogus".',
  );
});

test("a 429 with Retry-After (seconds) waits for that delay", async () => {
  let calls = 0;
  const mt = makeMockTransport((): HttpResponse => {
    calls += 1;
    if (calls === 1) {
      return {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "2" },
        body: Buffer.from("{}"),
      };
    }
    return jsonResponse({ ok: 1 });
  });
  const slept: number[] = [];
  const e = new RequestEngine({
    transport: mt.transport,
    retryDelayMs: 200,
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  assert.deepEqual(await e.getJson("/x"), { ok: 1 });
  assert.deepEqual(slept, [2000]); // Retry-After wins over the linear default (200)
});

test("a pathological Retry-After is clamped to the ceiling (AUT-01)", async () => {
  // A hostile/misconfigured endpoint answers with an enormous Retry-After; the
  // sleep must be clamped rather than hanging the CLI for hours.
  let calls = 0;
  const mt = makeMockTransport((): HttpResponse => {
    calls += 1;
    if (calls === 1) {
      return {
        status: 503,
        headers: { "content-type": "application/json", "retry-after": "99999999" },
        body: Buffer.from("{}"),
      };
    }
    return jsonResponse({ ok: 1 });
  });
  const slept: number[] = [];
  const e = new RequestEngine({
    transport: mt.transport,
    retryDelayMs: 200,
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  await e.getJson("/x");
  // 99999999s (~27h) is clamped down to the 30s ceiling, not honoured verbatim.
  assert.deepEqual(slept, [30_000]);
});

test("a 429 without Retry-After backs off exponentially from 1 s, at most 30 s", async () => {
  const slept: number[] = [];
  const e = new RequestEngine({
    transport: makeMockTransport(() => jsonResponse({}, 429)).transport,
    maxRetries: 7,
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  await assert.rejects(() => e.getJson("/x"), AutobahnApiError);
  assert.deepEqual(slept, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
});

test("falls back to linear backoff when Retry-After is absent", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return calls === 1 ? jsonResponse({}, 503) : jsonResponse({ ok: 1 });
  });
  const slept: number[] = [];
  const e = new RequestEngine({
    transport: mt.transport,
    retryDelayMs: 200,
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  await e.getJson("/x");
  assert.deepEqual(slept, [200]);
});

test("gateway errors 502 and 504 are retried like 503; 500 is not", async () => {
  for (const status of [502, 504]) {
    let calls = 0;
    const mt = makeMockTransport(() => {
      calls += 1;
      return calls === 1 ? rawResponse("<html>Bad Gateway</html>", "text/html", status) : jsonResponse({ ok: 1 });
    });
    const e = new RequestEngine({ transport: mt.transport, sleep: async () => {} });
    assert.deepEqual(await e.getJson("/x"), { ok: 1 }, String(status));
    assert.equal(mt.calls.length, 2, String(status));

    const failing = makeMockTransport(() => rawResponse("", "text/html", status));
    const e2 = new RequestEngine({ transport: failing.transport, sleep: async () => {} });
    await assert.rejects(
      () => e2.getJson("/x"),
      (err: unknown) => err instanceof AutobahnApiError && err.status === status && err.isRetryable,
      String(status),
    );
    assert.equal(failing.calls.length, 3, String(status)); // 1 + maxRetries (2)
  }
  const mt = makeMockTransport(() => jsonResponse({}, 500));
  const e = new RequestEngine({ transport: mt.transport, sleep: async () => {} });
  await assert.rejects(() => e.getJson("/x"), AutobahnApiError);
  assert.equal(mt.calls.length, 1);
});

test("sanitizeServerText drops whole escape sequences, not just their control bytes", () => {
  const ESC = String.fromCharCode(0x1b);
  const BEL = String.fromCharCode(0x07);
  const CSI8 = String.fromCharCode(0x9b);
  const OSC8 = String.fromCharCode(0x9d);
  const ST8 = String.fromCharCode(0x9c);
  for (const [input, expected] of [
    [`line1 ${ESC}]0;title${BEL}rest`, "line1 rest"],
    [`${ESC}]8;;https://evil.example${ESC}\\click${ESC}]8;;${ESC}\\`, "click"],
    [`${ESC}[31mred${ESC}[0m plain`, "red plain"],
    [`${ESC}[1;31;4mbold`, "bold"],
    [`${CSI8}2Jcleared`, "cleared"],
    [`${OSC8}0;t${ST8}ok`, "ok"],
    [`a${ESC}7b${ESC}(Bc`, "abc"],
    // Unterminated: only ESC and its introducer go, the text stays.
    [`keep ${ESC}]0;no terminator here`, "keep 0;no terminator here"],
  ] as const) {
    assert.equal(sanitizeServerText(input), expected, JSON.stringify(input));
  }
});

test("parseRetryAfter handles seconds, HTTP-date, arrays and junk", () => {
  assert.equal(parseRetryAfter("120"), 120_000);
  assert.equal(parseRetryAfter("0"), 0);
  assert.equal(parseRetryAfter(["5"]), 5_000);
  assert.equal(parseRetryAfter(undefined), undefined);
  assert.equal(parseRetryAfter(""), undefined);
  assert.equal(parseRetryAfter("not-a-date"), undefined);
  // An HTTP-date in the past clamps to 0.
  assert.equal(parseRetryAfter("Wed, 21 Oct 2015 07:28:00 GMT"), 0);
  // V8's Date.parse reads these as dates in 2001 (a 0 ms delay); they must be junk.
  for (const junk of ["1.5", "-5", "+5", "1e3", "0x10", " 3x", "2026-10-03T10:00:00Z", "Sunday, 06-Nov-94 08:49:37 GMT"]) {
    assert.equal(parseRetryAfter(junk), undefined, junk);
  }
});

test("a malformed Retry-After falls back to the backoff instead of retrying at once", async () => {
  for (const header of ["1.5", "-5"]) {
    const mt = makeMockTransport((): HttpResponse => ({
      status: 429,
      headers: { "content-type": "application/json", "retry-after": header },
      body: Buffer.from("{}"),
    }));
    const slept: number[] = [];
    const e = new RequestEngine({ transport: mt.transport, retryDelayMs: 200, sleep: async (ms) => void slept.push(ms) });
    await assert.rejects(() => e.getJson("/x"), AutobahnApiError);
    assert.deepEqual(slept, [1000, 2000], header); // a 429: the rate-limit backoff
  }
});

test("an API error surfaces the body's detail field in the message", async () => {
  const mt = makeMockTransport(() => jsonResponse({ detail: "boom" }, 400));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) =>
      err instanceof AutobahnApiError &&
      err.status === 400 &&
      err.detail === "boom" &&
      err.isRetryable === false &&
      /boom/.test(err.message),
  );
});

test("error detail is stripped of terminal control characters (AUT-03)", async () => {
  // ESC + CSI + BEL interleaved with printable text in the error body's detail.
  const evil = `boom${ESC}[31mred${BEL}${CSI}2J`;
  const mt = makeMockTransport(() => jsonResponse({ detail: evil }, 500));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/x"),
    (err: unknown) => {
      assert.ok(err instanceof AutobahnApiError);
      // The control bytes are gone from both the structured detail and the
      // human-readable message that run.ts prints raw to stderr...
      assert.ok(!hasControlChars(err.detail ?? ""));
      assert.ok(!hasControlChars(err.message));
      // ...along with the rest of each escape sequence, while the text is preserved.
      assert.equal(err.detail, "boomred");
      return true;
    },
  );
});

test("an API error falls back to the body's message field", async () => {
  const mt = makeMockTransport(() => jsonResponse({ message: "fallback" }, 400));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => err instanceof AutobahnApiError && err.detail === "fallback",
  );
});

test("an API error tolerates a non-JSON body (no detail)", async () => {
  const mt = makeMockTransport(() => rawResponse("<html>oops</html>", "text/html", 500));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => err instanceof AutobahnApiError && err.detail === undefined && err.isRetryable === false,
  );
});

test("a userAgent Node cannot send is rejected at construction, before any request", () => {
  for (const [userAgent, reason] of [
    ["a\r\nX-Evil: 1", "Value contains control characters."],
    ["   ", "Expected a non-empty value."],
    ["", "Expected a non-empty value."],
    ["snow \u2603", "Value contains characters outside Latin-1 (above U+00FF)."],
  ] as const) {
    const mt = makeMockTransport(() => jsonResponse({}));
    assert.throws(
      () => new RequestEngine({ transport: mt.transport, userAgent }),
      (err: unknown) =>
        err instanceof AutobahnValidationError &&
        !(err instanceof AutobahnNetworkError) &&
        err.message === `Invalid option userAgent: ${reason}`,
      JSON.stringify(userAgent),
    );
    assert.equal(mt.calls.length, 0);
  }
  // Latin-1 and tab are fine; only an omitted userAgent means the default.
  for (const userAgent of ["M\u00fctze\tbot/1", undefined]) {
    assert.doesNotThrow(() => new RequestEngine({ userAgent }), JSON.stringify(userAgent));
  }
});

test("the User-Agent and Accept headers are sent", async () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  const e = new RequestEngine({ transport: mt.transport, userAgent: "ua/1" });
  await e.getJson("/x");
  assert.equal(mt.last().headers?.["User-Agent"], "ua/1");
  assert.equal(mt.last().headers?.["Accept"], "application/json");
});

test("a base URL with a query or fragment is rejected at construction", () => {
  for (const baseUrl of ["https://example.test/?x=1", "https://example.test/#frag", "https://example.test?"]) {
    const mt = makeMockTransport(() => jsonResponse({}));
    assert.throws(
      () => new RequestEngine({ transport: mt.transport, baseUrl }),
      (err: unknown) =>
        err instanceof AutobahnValidationError &&
        !(err instanceof AutobahnNetworkError) &&
        err.message === "Invalid option baseUrl: A base URL cannot have a query (?) or fragment (#).",
      baseUrl,
    );
    assert.equal(mt.calls.length, 0, baseUrl);
  }
});

test("a base URL with surrounding whitespace or a control character is rejected at construction", () => {
  for (const [baseUrl, reason] of [
    ["https://example.test/ ", "A base URL cannot have surrounding whitespace."],
    [" https://example.test", "A base URL cannot have surrounding whitespace."],
    ["https://example.test\n", "A base URL cannot have surrounding whitespace."],
    ["https://example.test/\u00a0", "A base URL cannot have surrounding whitespace."],
    ["https://example.test/a\tb", "A base URL cannot contain control characters."],
  ] as const) {
    const mt = makeMockTransport(() => jsonResponse({}));
    assert.throws(
      () => new RequestEngine({ transport: mt.transport, baseUrl }),
      (err: unknown) => err instanceof AutobahnValidationError && err.message === `Invalid option baseUrl: ${reason}`,
      JSON.stringify(baseUrl),
    );
    assert.equal(mt.calls.length, 0, JSON.stringify(baseUrl));
  }
});

test("redactUrl hides userinfo and leaves other URLs alone", () => {
  assert.equal(redactUrl("https://u:p@example.test/a?b=1"), "https://***@example.test/a?b=1");
  assert.equal(redactUrl("https://token@example.test/"), "https://***@example.test/");
  assert.equal(redactUrl("https://example.test/a b"), "https://example.test/a b");
  assert.equal(redactUrl("not a url"), "not a url");
  const err = new AutobahnApiError({ status: 500, url: "https://u:p@example.test/x", method: "GET", body: "" });
  assert.equal(err.url, "https://***@example.test/x");
  assert.ok(!err.message.includes("u:p"));
});

test("error detail loses bidi controls and line breaks, so it cannot reorder or forge lines", async () => {
  const RLO = String.fromCharCode(0x202e);
  const LRI = String.fromCharCode(0x2066);
  const detail = `bad ${ESC}]0;PWNED${BEL} line1\r\nError: forged\u2028x\t ${RLO}evil${LRI}`;
  const mt = makeMockTransport(() => jsonResponse({ message: detail }, 500));
  const e = new RequestEngine({ transport: mt.transport, maxRetries: 0 });
  await assert.rejects(
    () => e.getJson("/x"),
    (err: unknown) => {
      assert.ok(err instanceof AutobahnApiError);
      assert.equal(err.detail, "bad line1 Error: forged x evil");
      assert.ok(!/[\n\r\u2028\u202e\u2066]/.test(err.message));
      return true;
    },
  );
});

test("a huge error detail is cut at 500 characters; the body keeps it whole", async () => {
  const message = "x".repeat(200_000);
  const mt = makeMockTransport(() => jsonResponse({ message }, 500));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/x"),
    (err: unknown) => {
      assert.ok(err instanceof AutobahnApiError);
      assert.equal(err.detail, `${"x".repeat(500)}…`);
      assert.ok(err.message.length < 1000);
      assert.equal(err.body, JSON.stringify({ message }));
      return true;
    },
  );
});

test("sanitizeServerText drops invisible format characters (zero-width, soft hyphen, BOM)", () => {
  const text = "real\u200b error\u2028Error: forged\u2066x\u2069 \ufeffend\u00ad\u200d\u2060!";
  assert.equal(sanitizeServerText(text), "real error Error: forgedx end!");
});

test("sanitizeServerText keeps ordinary text, umlauts and single spaces", () => {
  assert.equal(sanitizeServerText("  Cannot GET  /autobahn/details/  Größe  "), "Cannot GET /autobahn/details/ Größe");
});

test("a 3xx names the redirect target instead of a bare status", async () => {
  const cases: Array<[string | undefined, string]> = [
    ["https://verkehr.autobahn.de/o/autobahn/", ": redirect to https://verkehr.autobahn.de/o/autobahn/ not followed"],
    ["/elsewhere", ": redirect to http://verkehr.autobahn.de/elsewhere not followed"],
    ["https://u:p@evil.test/\u202ex", ": redirect to https://***@evil.test/%E2%80%AEx not followed"],
    [undefined, ": redirect not followed (no Location header)"],
  ];
  for (const [location, suffix] of cases) {
    const mt = makeMockTransport(() => ({
      status: 301,
      headers: location === undefined ? {} : { location },
      body: Buffer.alloc(0),
    }));
    const e = new RequestEngine({ transport: mt.transport, baseUrl: "http://verkehr.autobahn.de" });
    await assert.rejects(
      () => e.getJson("/o/autobahn/"),
      (err: unknown) => {
        assert.ok(err instanceof AutobahnApiError);
        assert.equal(err.message, `HTTP 301 for GET http://verkehr.autobahn.de/o/autobahn/${suffix}`);
        return true;
      },
      String(location),
    );
    assert.equal(mt.calls.length, 1); // still not followed
  }
});

test("a 304 or 305 is not called a redirect; a 300 without a target isn't either", async () => {
  for (const [status, location] of [[304, undefined], [305, undefined], [300, undefined]] as const) {
    const e = new RequestEngine({ transport: async () => ({ status, headers: location ? { location } : {}, body: Buffer.alloc(0) }), maxRetries: 0 });
    await assert.rejects(
      () => e.getJson("/x"),
      (err: unknown) => err instanceof AutobahnApiError && err.message === `HTTP ${status} for GET https://verkehr.autobahn.de/x`,
      String(status),
    );
  }
  const e = new RequestEngine({ transport: async () => ({ status: 300, headers: { location: "/y" }, body: Buffer.alloc(0) }), maxRetries: 0 });
  await assert.rejects(() => e.getJson("/x"), /redirect to https:\/\/verkehr\.autobahn\.de\/y not followed/);
});

test("cutText never cuts inside a surrogate pair; toWellFormed replaces half a character", () => {
  assert.equal(cutText("ab\u{1f600}cd", 3), "ab");
  assert.equal(cutText("ab\u{1f600}cd", 4), "ab\u{1f600}");
  assert.equal(cutText("short", 10), "short");
  assert.equal(toWellFormed("a\ud83d b\ude00 \u{1f600}"), "a\ufffd b\ufffd \u{1f600}");
});

test("a server detail, a quoted value and a long URL cut at 500 characters keep the message well-formed", async () => {
  const detail = "a" + "\u{1f600}".repeat(400);
  const engine = new RequestEngine({ transport: async () => ({ status: 500, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ detail })) }) });
  await assert.rejects(engine.getJson("/o/autobahn/"), (err: Error) => {
    assert.equal(toWellFormed(err.message), err.message);
    assert.match(err.message, /…$/);
    return true;
  });
  // quoteValue cuts before quoting: half a character would be the text \ud83d in the message.
  const quoted = quoteValue(detail);
  assert.match(quoted, /…$/);
  assert.doesNotMatch(quoted, /\\ud83d"/);
});

test("an unknown charset is quoted at most 500 characters long (L3)", async () => {
  const charset = "x".repeat(5000);
  const engine = new RequestEngine({ transport: async () => ({ status: 200, headers: { "content-type": `application/json; charset=${charset}` }, body: Buffer.from("{}") }) });
  await assert.rejects(engine.getJson("/o/autobahn/"), (err: Error) => err.message.length < 700 && /^GET \S+: unsupported response charset "x+…"\.$/.test(err.message));
});

test("credentials a server echoes are scrubbed from the error: Basic, user:password, password (L13)", async () => {
  // Node sends the userinfo's Basic value in UTF-8: "ü" is two bytes there.
  const basic = Buffer.from("alice:pa ss-pwü", "utf8").toString("base64");
  const body = JSON.stringify({ detail: `no: Basic ${basic} / alice:pa ss-pwü / pa ss-pwü` });
  const engine = new RequestEngine({
    baseUrl: "https://alice:pa%20ss-pw%C3%BC@mirror.example",
    transport: async () => ({ status: 401, headers: { "content-type": "application/json" }, body: Buffer.from(body) }),
  });
  await assert.rejects(engine.getJson("/o/autobahn/"), (err: AutobahnApiError) => {
    for (const form of [basic, "alice:pa ss-pwü", "pa ss-pwü"]) {
      assert.ok(!err.message.includes(form), err.message);
      assert.ok(!err.body.includes(form), err.body);
    }
    assert.match(err.message, /no: Basic \*\*\* \/ \*\*\* \/ \*\*\*/);
    return true;
  });
});

test("a header named __proto__ is an ordinary header, never the prototype of the headers read (T12)", async () => {
  // A JavaScript transport may return any object; JSON.parse makes "__proto__" an own key.
  const headers = JSON.parse('{"__proto__":{"content-type":"text/html"}}') as Record<string, string>;
  const e = new RequestEngine({ transport: async () => ({ status: 200, headers, body: Buffer.from("<html>") }) });
  // With the prototype set, "text/html" was read as the Content-Type and named in the message.
  await assert.rejects(e.getJson("/x"), (err: Error) => err.message === "GET https://verkehr.autobahn.de/x: the answer is not valid JSON.");
  const fetchLike = new Headers([["__proto__", "x"], ["content-type", "application/json"]]);
  const f = new RequestEngine({ transport: async () => ({ status: 200, headers: fetchLike as unknown as Record<string, string>, body: Buffer.from('{"a":1}') }) });
  assert.deepEqual(await f.getJson("/x"), { a: 1 });
});

test("bigIntegerKeys: a declared member's number is its exact literal as a string; others keep the rule (D3)", async () => {
  const body = '{"_version_":1858054135406919680,"small":{"_version_":5},"neg":{"\\u005fversion_":-12345678901234567890},' +
    '"s":{"_version_":"text"},"n":{"_version_":null},"arr":{"_version_":[1]},"t":"\\"_version_\\":1","n2":42}';
  const e = new RequestEngine({
    bigIntegerKeys: new Set(["_version_"]),
    transport: makeMockTransport(() => rawResponse(body, "application/json")).transport,
  });
  assert.deepEqual(await e.getJson("/x"), {
    _version_: "1858054135406919680", small: { _version_: "5" }, neg: { _version_: "-12345678901234567890" },
    s: { _version_: "text" }, n: { _version_: null }, arr: { _version_: [1] }, t: '"_version_":1', n2: 42,
  });
  assert.deepEqual([...e.bigIntegerKeys], ["_version_"]);
  // An undeclared big number is still refused; a declared member doesn't make others exact.
  const other = new RequestEngine({
    bigIntegerKeys: ["_version_"] as unknown as ReadonlySet<string>,
    transport: makeMockTransport(() => rawResponse('{"_version_":1858054135406919680,"id":12345678901234567890}', "application/json")).transport,
  });
  await assert.rejects(other.getJson("/x"), /the number 12345678901234567890 cannot be represented exactly/);
  // Malformed stays malformed: a declared member with a leading zero still fails JSON.parse.
  const malformed = new RequestEngine({ bigIntegerKeys: new Set(["_version_"]), transport: makeMockTransport(() => rawResponse('{"_version_":01}', "application/json")).transport });
  await assert.rejects(malformed.getJson("/x"), /not valid JSON/);
  for (const bad of [new Set([""]), new Set([1]), "x", 5, null]) {
    assert.throws(() => new RequestEngine({ bigIntegerKeys: bad as unknown as ReadonlySet<string> }),
      (err: unknown) => err instanceof AutobahnValidationError && err.message === "Invalid option bigIntegerKeys: expected a set of non-empty member names.");
  }
  // The option reader copies a set or a list; undefined is none.
  const names = new Set(["a"]);
  const copy = bigIntegerKeysOption(names);
  names.add("b");
  assert.deepEqual([...copy], ["a"]);
  assert.deepEqual([...bigIntegerKeysOption(["x", "y"] as unknown as ReadonlySet<string>)], ["x", "y"]);
  assert.equal(bigIntegerKeysOption(undefined).size, 0);
  // Without declarations the scan is the plain number check.
  assert.equal(firstInexactNumber('{"a":"1e400","b":3e-324}'), "3e-324");
  assert.deepEqual(scanNumbers('{"a":1}'), { json: '{"a":1}', inexact: undefined });
});

test("an answer error names the request: method and URL, userinfo redacted (D9)", async () => {
  const answers: Array<[string, () => HttpResponse]> = [
    ["not valid JSON", () => rawResponse("<html>", "text/html")],
    ["empty response body", () => rawResponse(" ", "application/json")],
    ["cannot be represented exactly", () => rawResponse('{"n":1e400}', "application/json")],
    ["unsupported response charset", () => rawResponse("{}", "application/json; charset=x-bogus")],
    ["unsupported Content-Encoding", () => ({ status: 200, headers: { "content-type": "application/json", "content-encoding": "br" }, body: Buffer.from("{}") })],
  ];
  const base = new URL("https://verkehr.autobahn.de");
  base.username = "alice";
  base.password = "s3cret";
  for (const [what, respond] of answers) {
    const e = new RequestEngine({ baseUrl: base.href, transport: makeMockTransport(respond).transport });
    await assert.rejects(e.getJson("/items", { q: "x" }), (err: unknown) => {
      assert.ok(err instanceof AutobahnParseError, what);
      assert.ok(err.message.startsWith(`GET ${base.protocol}//***@${base.host}`), err.message);
      assert.ok(err.message.includes("/items?q=x: ") && err.message.includes(what), err.message);
      assert.ok(!err.message.includes("s3cret"), err.message);
      return true;
    });
  }
});
