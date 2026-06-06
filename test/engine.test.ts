import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestEngine, parseRetryAfter } from "../src/client/engine.js";
import { AutobahnApiError, AutobahnParseError } from "../src/client/errors.js";
import type { HttpResponse } from "../src/client/http.js";
import { makeMockTransport, jsonResponse, rawResponse } from "./helpers.js";

test("buildUrl normalises the path and appends the query", () => {
  const e = new RequestEngine({ baseUrl: "https://example.test/" });
  assert.equal(e.buildUrl("o/autobahn/"), "https://example.test/o/autobahn/");
  assert.equal(
    e.buildUrl("/x", { a: "1", b: ["2", "3"] }),
    "https://example.test/x?a=1&b=2&b=3",
  );
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

test("parseRetryAfter handles seconds, HTTP-date, arrays and junk", () => {
  assert.equal(parseRetryAfter("120"), 120_000);
  assert.equal(parseRetryAfter("0"), 0);
  assert.equal(parseRetryAfter(["5"]), 5_000);
  assert.equal(parseRetryAfter(undefined), undefined);
  assert.equal(parseRetryAfter(""), undefined);
  assert.equal(parseRetryAfter("not-a-date"), undefined);
  // An HTTP-date in the past clamps to 0.
  assert.equal(parseRetryAfter("Wed, 21 Oct 2015 07:28:00 GMT"), 0);
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

test("the User-Agent and Accept headers are sent", async () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  const e = new RequestEngine({ transport: mt.transport, userAgent: "ua/1" });
  await e.getJson("/x");
  assert.equal(mt.last().headers?.["User-Agent"], "ua/1");
  assert.equal(mt.last().headers?.["Accept"], "application/json");
});
