import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { AutobahnClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { EngineOptions } from "../src/client/engine.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { AutobahnNetworkError } from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, rawResponse } from "./helpers.js";

function makeCli(responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>) {
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(responder);

  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    },
    createClient: (opts) => new AutobahnClient({ ...opts, transport: mt.transport }),
  };
  return { deps, out, err, mt };
}

test("roads prints the unwrapped array", async () => {
  const cli = makeCli(() => jsonResponse({ roads: ["A1", "A2"] }));
  const code = await run(["roads"], cli.deps);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(cli.out.join("\n")), ["A1", "A2"]);
  assert.equal(new URL(cli.mt.last().url).pathname, "/o/autobahn/");
});

test("roadworks list hits the right path", async () => {
  const cli = makeCli(() => jsonResponse({ roadworks: [{ identifier: "a" }] }));
  const code = await run(["roadworks", "list", "A3"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).pathname, "/o/autobahn/A3/services/roadworks");
});

test("charging get url-encodes the identifier", async () => {
  const cli = makeCli(() => jsonResponse({ identifier: "x" }));
  await run(["charging", "get", "abc/def"], cli.deps);
  assert.equal(
    new URL(cli.mt.last().url).pathname,
    "/o/autobahn/details/electric_charging_station/abc%2Fdef",
  );
});

test("--compact prints single-line JSON", async () => {
  const cli = makeCli(() => jsonResponse({ roads: ["A1"] }));
  await run(["--compact", "roads"], cli.deps);
  assert.equal(cli.out.join("\n"), '["A1"]');
});

test("a 404 from the API maps to exit code 4", async () => {
  const cli = makeCli(() => jsonResponse({ detail: "missing" }, 404));
  const code = await run(["warnings", "get", "nope"], cli.deps);
  assert.equal(code, 4);
  assert.match(cli.err.join("\n"), /Error: HTTP 404/);
});

test("an unknown command is a usage error (non-zero, no request)", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["bogus"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("get renders the detail object and exits 0", async () => {
  const cli = makeCli(() => jsonResponse({ identifier: "x", title: "A1 webcam" }));
  const code = await run(["webcams", "get", "x"], cli.deps);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(cli.out.join("\n")), { identifier: "x", title: "A1 webcam" });
});

test("a network error maps to exit code 1", async () => {
  const cli = makeCli(() => {
    throw new AutobahnNetworkError("connect ECONNREFUSED");
  });
  const code = await run(["roads"], cli.deps);
  assert.equal(code, 1);
  assert.match(cli.err.join("\n"), /Error: connect ECONNREFUSED/);
});

test("a parse error (non-JSON body) maps to exit code 1", async () => {
  const cli = makeCli(() => rawResponse("<html>not json</html>", "text/html"));
  const code = await run(["roads"], cli.deps);
  assert.equal(code, 1);
  assert.match(cli.err.join("\n"), /Error: Failed to parse JSON/);
});

test("an unexpected (non-Autobahn) error maps to exit code 1", async () => {
  const cli = makeCli(() => {
    throw new Error("kaboom");
  });
  const code = await run(["roads"], cli.deps);
  assert.equal(code, 1);
  assert.match(cli.err.join("\n"), /Unexpected error: kaboom/);
});

test("--help exits 0", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["--help"], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("--version exits 0", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["--version"], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("an invalid --timeout is a usage error (non-zero, no request)", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["--timeout", "1e3", "roads"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("global options flow through to the client engine", async () => {
  const seen: EngineOptions[] = [];
  const mt = makeMockTransport(() => jsonResponse({ roads: [] }));
  const deps: CliDeps = {
    io: { out: () => {}, err: () => {} },
    createClient: (opts) => {
      seen.push(opts);
      return new AutobahnClient({ ...opts, transport: mt.transport });
    },
  };
  const code = await run(
    [
      "--base-url",
      "https://example.test",
      "--timeout",
      "5000",
      "--max-retries",
      "1",
      "--max-response-bytes",
      "1024",
      "--user-agent",
      "test/1",
      "roads",
    ],
    deps,
  );
  assert.equal(code, 0);
  assert.deepEqual(seen[0], {
    baseUrl: "https://example.test",
    timeoutMs: 5000,
    maxRetries: 1,
    maxResponseBytes: 1024,
    userAgent: "test/1",
  });
  assert.equal(new URL(mt.last().url).origin, "https://example.test");
});
