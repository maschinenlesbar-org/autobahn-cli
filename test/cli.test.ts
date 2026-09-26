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

test("roads trims ids and drops the duplicates that trimming creates", async () => {
  // Live on 2026-09-15 the API listed both "A60" and "A60 ".
  const cli = makeCli(() => jsonResponse({ roads: ["A6", "A60", "A60 ", " A61", "A61"] }));
  const code = await run(["--compact", "roads"], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.out.join("\n"), '["A6","A60","A61"]');
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

test("DEL and C1 control characters in server data are escaped in the JSON output", async () => {
  const controls = String.fromCharCode(0x7f, 0x85, 0x9b) + "2J";
  const served = { identifier: "x", title: `A1${controls}`, subtitle: String.fromCharCode(0x1b) + "[31m" };
  for (const format of [[], ["--compact"]]) {
    const cli = makeCli(() => jsonResponse(served));
    assert.equal(await run([...format, "webcams", "get", "x"], cli.deps), 0);
    const text = cli.out.join("\n");
    const raw = [...text].filter((c) => c.charCodeAt(0) < 0x20 ? c !== "\n" : c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) <= 0x9f);
    assert.deepEqual(raw, [], format.join(" "));
    assert.match(text, /A1\\u007f\\u0085\\u009b2J/);
    assert.deepEqual(JSON.parse(text), served);
  }
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

test("a bare invocation prints help to stdout (not stderr), exit 0", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run([], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.equal(cli.err.length, 0); // help on stdout, not stderr
  assert.match(cli.out.join("\n"), /Usage: autobahn/);
});

test("a global flag with no command prints help to stdout, exit 0", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["--compact"], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.err.length, 0);
  assert.match(cli.out.join("\n"), /Usage: autobahn/);
});

test("a bare command group prints its help to stdout, exit 0", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["roadworks"], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.err.length, 0);
  assert.match(cli.out.join("\n"), /list|get/);
});

test("an unknown command still errors on stderr with exit 1", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["bogus"], cli.deps);
  assert.equal(code, 1);
  assert.equal(cli.out.length, 0);
  assert.match(cli.err.join("\n"), /unknown command 'bogus'/);
});

test("an invalid --timeout is a usage error (non-zero, no request)", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["--timeout", "1e3", "roads"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("a non-http(s) or malformed --base-url is a usage error (non-zero, no request)", async () => {
  for (const bad of ["file:///etc/passwd", "ftp://example.org", "notaurl"]) {
    const cli = makeCli(() => jsonResponse({ roads: [] }));
    const code = await run(["--base-url", bad, "roads"], cli.deps);
    assert.notEqual(code, 0, bad);
    assert.equal(cli.mt.calls.length, 0, bad);
    assert.match(cli.err.join("\n"), /--base-url/, bad);
  }
});

test("--timeout accepts up to the largest timer Node supports", async () => {
  const cli = makeCli(() => jsonResponse({ roads: [] }));
  assert.equal(await run(["--timeout", "2147483647", "roads"], cli.deps), 0);
  assert.equal(cli.mt.last().timeoutMs, 2_147_483_647);

  // Commander parse errors exit 1 in this CLI.
  const over = makeCli(() => jsonResponse({ roads: [] }));
  assert.equal(await run(["--timeout", "2147483648", "roads"], over.deps), 1);
  assert.equal(over.mt.calls.length, 0);
  assert.match(over.err.join("\n"), /from 0 to 2147483647/);
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

test("a road id of .. exits 1 without a request instead of printing another endpoint's answer", async () => {
  const cli = makeCli(() => jsonResponse({ roadworks: [] }));
  const code = await run(["--compact", "roadworks", "list", ".."], cli.deps);
  assert.equal(code, 1);
  assert.equal(cli.mt.calls.length, 0);
  assert.deepEqual(cli.out, []);
  assert.match(cli.err.join("\n"), /^Error: Invalid path segment "\.\."/);
});

test("a 2xx body without the service envelope exits 1 instead of printing []", async () => {
  const cli = makeCli(() => jsonResponse({ roadworks: "oops", error: "down" }));
  const code = await run(["--compact", "roadworks", "list", "A1"], cli.deps);
  assert.equal(code, 1);
  assert.deepEqual(cli.out, []);
  assert.equal(
    cli.err.join("\n"),
    "Error: Unexpected response shape from /o/autobahn/A1/services/roadworks: expected a JSON object with a roadworks array.",
  );
});

test("a mistyped or wrong-case road id exits 4 instead of printing [] (a false all-clear)", async () => {
  const cli = makeCli((req) =>
    new URL(req.url).pathname === "/o/autobahn/" ? jsonResponse({ roads: ["A1", "A2"] }) : jsonResponse({ warning: [] }),
  );
  const code = await run(["--compact", "warnings", "list", "a1"], cli.deps);
  assert.equal(code, 4);
  assert.deepEqual(cli.out, []);
  assert.equal(cli.err.join("\n"), 'Error: Unknown road id "a1": not in the API\'s road list (did you mean "A1"?).');
});

test("a known road with nothing listed still prints [] and exits 0", async () => {
  const cli = makeCli((req) =>
    new URL(req.url).pathname === "/o/autobahn/" ? jsonResponse({ roads: ["A1", "A2"] }) : jsonResponse({ warning: [] }),
  );
  assert.equal(await run(["--compact", "warnings", "list", "A2"], cli.deps), 0);
  assert.equal(cli.out.join("\n"), "[]");
});

test("a --base-url with a query, a fragment or surrounding whitespace is a usage error", async () => {
  for (const [baseUrl, message] of [
    ["http://127.0.0.1:18103/echo?x=1", /cannot have a query \(\?\) or fragment \(#\)/],
    ["http://127.0.0.1:18103/echo#frag", /cannot have a query \(\?\) or fragment \(#\)/],
    ["http://127.0.0.1:18103?", /cannot have a query \(\?\) or fragment \(#\)/],
    [" https://verkehr.autobahn.de", /cannot have surrounding whitespace/],
    ["https://verkehr.autobahn.de\t", /cannot have surrounding whitespace/],
  ] as const) {
    const cli = makeCli(() => jsonResponse({ roads: ["A1"] }));
    const code = await run(["--base-url", baseUrl, "roads"], cli.deps);
    assert.equal(code, 1, baseUrl);
    assert.equal(cli.mt.calls.length, 0, baseUrl);
    assert.match(cli.err.join("\n"), message, baseUrl);
  }
});

test("a --base-url with a path prefix still works", async () => {
  const cli = makeCli(() => jsonResponse({ roads: ["A1"] }));
  assert.equal(await run(["--base-url", "https://mirror.example/autobahn/", "roads"], cli.deps), 0);
  assert.equal(cli.mt.last().url, "https://mirror.example/autobahn/o/autobahn/");
});

test("schema-violating bodies exit 1 with a parse error, not an 'Unexpected error' TypeError", async () => {
  for (const [argv, body] of [
    [["roads"], null],
    [["roads"], { roads: [null, 5, "A1", "A1 "] }],
    [["roadworks", "list", "A1"], null],
    [["roadworks", "get", "x"], null],
  ] as const) {
    const cli = makeCli(() => jsonResponse(body));
    assert.equal(await run([...argv], cli.deps), 1, argv.join(" "));
    assert.match(cli.err.join("\n"), /^Error: Unexpected response shape from \/o\/autobahn\//, argv.join(" "));
  }
});
