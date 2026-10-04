import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestEngine, parseRetryAfter, sanitizeServerText } from "../src/client/engine.js";
import {
  AutobahnApiError,
  AutobahnNetworkError,
  AutobahnParseError,
  AutobahnValidationError,
  redactUrl,
} from "../src/client/errors.js";
import type { HttpResponse } from "../src/client/http.js";
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
    (err: unknown) => err instanceof AutobahnParseError && err.message === 'Unsupported response charset "x-bogus" from /x.',
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

test("a malformed Retry-After falls back to linear backoff instead of retrying at once", async () => {
  for (const header of ["1.5", "-5"]) {
    const mt = makeMockTransport((): HttpResponse => ({
      status: 429,
      headers: { "content-type": "application/json", "retry-after": header },
      body: Buffer.from("{}"),
    }));
    const slept: number[] = [];
    const e = new RequestEngine({ transport: mt.transport, retryDelayMs: 200, sleep: async (ms) => void slept.push(ms) });
    await assert.rejects(() => e.getJson("/x"), AutobahnApiError);
    assert.deepEqual(slept, [200, 400], header);
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
      // ...while the printable characters are preserved.
      assert.equal(err.detail, "boom[31mred2J");
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
      assert.equal(err.detail, "bad ]0;PWNED line1 Error: forged x evil");
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
