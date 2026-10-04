import { test } from "node:test";
import assert from "node:assert/strict";
import { redactUserinfo, run } from "../src/cli/run.js";
import { AutobahnClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { EngineOptions } from "../src/client/engine.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { AutobahnNetworkError, AutobahnValidationError } from "../src/client/errors.js";
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
  await run(["charging", "get", "ab+c=d"], cli.deps);
  assert.equal(
    new URL(cli.mt.last().url).pathname,
    "/o/autobahn/details/electric_charging_station/ab%2Bc%3Dd",
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

test("get exits 1 when the API answers about another item", async () => {
  const cli = makeCli(() => jsonResponse({ identifier: "x" }));
  const code = await run(["webcams", "get", "abc"], cli.deps);
  assert.equal(code, 1);
  assert.deepEqual(cli.out, []);
  assert.match(cli.err.join("\n"), /asked for identifier "abc", got "x"\.$/);
});

test("a 404 from roads or a list exits 1 (a wrong base URL), not 4", async () => {
  for (const argv of [["roads"], ["roadworks", "list", "A1"]]) {
    const cli = makeCli(() => rawResponse("Cannot GET /x", "text/html", 404));
    assert.equal(await run(argv, cli.deps), 1, argv.join(" "));
    assert.match(cli.err.join("\n"), /so the base URL is probably wrong\.$/, argv.join(" "));
  }
});

test("a network error maps to exit code 1", async () => {
  const cli = makeCli(() => {
    throw new AutobahnNetworkError("connect ECONNREFUSED");
  });
  const code = await run(["roads"], cli.deps);
  assert.equal(code, 1);
  assert.match(cli.err.join("\n"), /^Error: GET https:\/\/verkehr\.autobahn\.de\/o\/autobahn\/ failed: connect ECONNREFUSED$/);
});

test("a parse error (non-JSON body) maps to exit code 1", async () => {
  const cli = makeCli(() => rawResponse("<html>not json</html>", "text/html"));
  const code = await run(["roads"], cli.deps);
  assert.equal(code, 1);
  assert.match(cli.err.join("\n"), /Error: Failed to parse JSON/);
});

test("an unexpected (non-Autobahn) error maps to exit code 1", async () => {
  const cli = makeCli(() => jsonResponse({}));
  cli.deps.createClient = () => {
    throw new Error("kaboom");
  };
  const code = await run(["roads"], cli.deps);
  assert.equal(code, 1);
  assert.match(cli.err.join("\n"), /Unexpected error: kaboom/);
});

test("an error thrown by an injected transport is a network error, not 'Unexpected error'", async () => {
  const cli = makeCli(() => {
    throw new Error("kaboom");
  });
  const code = await run(["roads"], cli.deps);
  assert.equal(code, 1);
  assert.equal(cli.err.join("\n"), "Error: GET https://verkehr.autobahn.de/o/autobahn/ failed: kaboom");
});

test("--help exits 0", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["--help"], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("list help names what it lists, and --max-retries help names the fallback backoff", async () => {
  for (const [group, line] of [
    ["charging", "List electric charging stations along a motorway (e.g. A1)"],
    ["parking", "List lorry parking areas along a motorway (e.g. A1)"],
    ["roadworks", "List roadworks along a motorway (e.g. A1)"],
  ] as const) {
    const cli = makeCli(() => jsonResponse({}));
    assert.equal(await run([group, "--help"], cli.deps), 0);
    assert.ok(cli.out.join("\n").includes(line), group);
  }
  const cli = makeCli(() => jsonResponse({}));
  assert.equal(await run(["--help"], cli.deps), 0);
  assert.match(cli.out.join("\n").replace(/\s+/g, " "), /else a short linear backoff from 200 ms/);
});

test("combined short flags are read like separate ones by the -v and unknown-command rules", async () => {
  for (const argv of [["roads", "-vh"], ["roads", "-hv"]]) {
    const cli = makeCli(() => jsonResponse({ roads: ["A1"] }));
    assert.equal(await run(argv, cli.deps), 1, argv.join(" "));
    assert.equal(cli.out.length, 0, argv.join(" "));
    assert.match(cli.err.join("\n"), /^error: the version flag \(-V, --version, or -v\) only works before the command/, argv.join(" "));
  }
  const unknown = makeCli(() => jsonResponse({}));
  assert.equal(await run(["bogus", "-hV"], unknown.deps), 1);
  assert.match(unknown.err.join("\n"), /unknown command 'bogus'/);
});

test("a version flag after a command is a usage error, not the version instead of the command", async () => {
  for (const argv of [
    ["roads", "-v"],
    ["roadworks", "list", "A1", "-v"],
    ["--compact", "roads", "-v"],
    ["roads", "-V"],
    ["roadworks", "get", "A1", "--version"],
    ["--user-agent", "-v", "roads", "-V"],
  ]) {
    const cli = makeCli(() => jsonResponse({ roads: ["A1"] }));
    assert.equal(await run(argv, cli.deps), 1, argv.join(" "));
    assert.equal(cli.out.length, 0, argv.join(" "));
    assert.equal(cli.mt.calls.length, 0, argv.join(" "));
    assert.match(cli.err.join("\n"), /^error: the version flag \(-V, --version, or -v\) only works before the command/, argv.join(" "));
  }
  // Before the command all three print the version.
  for (const argv of [["-v"], ["-v", "roads"], ["-V", "roads"], ["--version", "roads"], ["--version"]]) {
    const cli = makeCli(() => jsonResponse({}));
    assert.equal(await run(argv, cli.deps), 0, argv.join(" "));
    assert.match(cli.out.join("\n"), /^\d+\.\d+\.\d+/, argv.join(" "));
  }
});

test("-V, --version and the old -v all print the version; help shows -V", async () => {
  for (const flag of ["-V", "--version", "-v"]) {
    const cli = makeCli(() => jsonResponse({}));
    assert.equal(await run([flag], cli.deps), 0, flag);
    assert.match(cli.out.join("\n"), /^\d+\.\d+\.\d+/, flag);
    assert.equal(cli.mt.calls.length, 0, flag);
  }
  const help = makeCli(() => jsonResponse({}));
  await run(["--help"], help.deps);
  assert.match(help.out.join("\n"), /-V, --version/);
  assert.doesNotMatch(help.out.join("\n"), /-v\b/);
});

test("get help says where an identifier comes from", async () => {
  const cli = makeCli(() => jsonResponse({}));
  assert.equal(await run(["parking", "get", "--help"], cli.deps), 0);
  const help = cli.out.join("\n");
  assert.match(help, /identifier +the "identifier" field of an item from `parking list`/);
  assert.match(help, /autobahn parking list A1 \| jq -r '\.\[0\]\.identifier'/);
});

test("--max-retries help states its default", async () => {
  const cli = makeCli(() => jsonResponse({}));
  await run(["--help"], cli.deps);
  assert.match(cli.out.join("\n").replace(/\s+/g, " "), /--max-retries <n> retries for transient .*\(default 2, 0\.\.10;/);
});

test("--user-agent help shows the real default", async () => {
  const cli = makeCli(() => jsonResponse({}));
  await run(["--help"], cli.deps);
  const help = cli.out.join("\n").replace(/\s+/g, " ");
  assert.match(help, /\(default: "autobahn-cli\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/maschinenlesbar-org\/autobahn-cli\)"\)/);
  assert.doesNotMatch(help, /<project URL>/);
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

test("a help or version flag that is an option's value is kept", async () => {
  for (const flag of ["-h", "--help", "-V"]) {
    const cli = makeCli(() => jsonResponse({}));
    assert.equal(await run(["--user-agent", flag, "bogus"], cli.deps), 1, flag);
    assert.equal(cli.out.length, 0, flag);
    assert.match(cli.err.join("\n"), /unknown command 'bogus'/, flag);
  }
  const known = makeCli(() => jsonResponse({ roads: ["A1"] }));
  assert.equal(await run(["--user-agent", "-h", "roads"], known.deps), 0);
  assert.equal(known.mt.last().headers?.["User-Agent"], "-h");
});

test("an unknown command with a version flag is an unknown command (exit 1), not the version", async () => {
  for (const argv of [["services", "--version"], ["bogus", "-V"], ["-v", "services"], ["roadworks", "foo", "-V"]]) {
    const cli = makeCli(() => jsonResponse({}));
    assert.equal(await run(argv, cli.deps), 1, argv.join(" "));
    assert.equal(cli.out.length, 0, argv.join(" "));
    assert.match(cli.err.join("\n"), /unknown command '(services|bogus|foo)'/, argv.join(" "));
  }
});

test("an unknown command with --help is still an unknown command (exit 1), not help", async () => {
  for (const argv of [
    ["services", "--help"],
    ["-h", "services"],
    ["--base-url", "https://example.test", "services", "-h"],
    ["roadworks", "foo", "--help"],
  ]) {
    const cli = makeCli(() => jsonResponse({}));
    const code = await run(argv, cli.deps);
    assert.equal(code, 1, argv.join(" "));
    assert.match(cli.err.join("\n"), /unknown command '(services|foo)'/, argv.join(" "));
  }
  for (const argv of [["roadworks", "--help"], ["--base-url", "https://example.test", "roads", "--help"]]) {
    const cli = makeCli(() => jsonResponse({}));
    assert.equal(await run(argv, cli.deps), 0, argv.join(" "));
    assert.match(cli.out.join("\n"), /^Usage: autobahn/, argv.join(" "));
  }
});

test("help <path> --help prints the help of <path>, like help <path>", async () => {
  for (const argv of [["help", "roadworks", "list", "--help"], ["help", "roadworks", "list", "-h"], ["roadworks", "help", "get", "--help"]]) {
    const cli = makeCli(() => jsonResponse({}));
    assert.equal(await run(argv, cli.deps), 0, argv.join(" "));
    assert.match(cli.out[0] ?? "", /^Usage: autobahn roadworks (list|get) /, argv.join(" "));
  }
  // Without a path, `help --help` prints the root help, like `help`.
  const own = makeCli(() => jsonResponse({}));
  assert.equal(await run(["help", "--help"], own.deps), 0);
  assert.match(own.out.join("\n"), /^Usage: autobahn \[options\] \[command\]/);
});

test("help suggests the closest command for a typo, like commander does", async () => {
  for (const [argv, hint] of [
    [["help", "roadwork"], "(Did you mean roadworks?)"],
    [["help", "roadworks", "lst"], "(Did you mean list?)"],
    [["roadworks", "help", "gte"], "(Did you mean get?)"],
  ] as const) {
    const cli = makeCli(() => jsonResponse({}));
    assert.equal(await run([...argv], cli.deps), 1, argv.join(" "));
    assert.equal(cli.err.join("\n").split("\n")[1], hint, argv.join(" "));
  }
  const far = makeCli(() => jsonResponse({}));
  await run(["help", "zzzzzz"], far.deps);
  assert.doesNotMatch(far.err.join("\n"), /Did you mean/);
});

test("help walks the whole command path and rejects an unknown name", async () => {
  for (const [argv, usage] of [
    [["help"], "Usage: autobahn [options] [command]"],
    [["help", "roadworks"], "Usage: autobahn roadworks [options] [command]"],
    [["help", "roadworks", "list"], "Usage: autobahn roadworks list [options] <roadId>"],
    [["roadworks", "help", "get"], "Usage: autobahn roadworks get [options] <identifier>"],
  ] as const) {
    const cli = makeCli(() => jsonResponse({}));
    assert.equal(await run([...argv], cli.deps), 0, argv.join(" "));
    assert.equal(cli.out[0]?.split("\n")[0], usage, argv.join(" "));
    assert.equal(cli.mt.calls.length, 0);
  }
  for (const [argv, message] of [
    [["help", "roads", "extra"], "error: 'autobahn roads' has no subcommands (got 'extra')"],
    [["roadworks", "help", "list", "extra"], "error: 'autobahn roadworks list' has no subcommands (got 'extra')"],
  ] as const) {
    const cli = makeCli(() => jsonResponse({}));
    assert.equal(await run([...argv], cli.deps), 1, argv.join(" "));
    assert.equal(cli.err.join("\n").split("\n")[0], message, argv.join(" "));
  }
  for (const argv of [["help", "foo"], ["help", "roadworks", "bogus"], ["roadworks", "help", "bogus"]]) {
    const cli = makeCli(() => jsonResponse({}));
    assert.equal(await run(argv, cli.deps), 1, argv.join(" "));
    assert.match(cli.err.join("\n"), /^error: unknown command '(foo|bogus)'/, argv.join(" "));
  }
  const root = makeCli(() => jsonResponse({}));
  await run(["--help"], root.deps);
  assert.match(root.out.join("\n"), /\n {2}help \[command\.\.\.\] +display help for command$/m);
});

test("a usage error is the error plus a one-line pointer to the command's help, not the whole help", async () => {
  for (const [argv, hint] of [
    [["--max-retries", "11", "roads"], '(run "autobahn --help" for usage)'],
    [["roadworks", "list"], '(run "autobahn roadworks list --help" for usage)'],
    [["bogus"], '(run "autobahn --help" for usage)'],
  ] as const) {
    const cli = makeCli(() => jsonResponse({}));
    assert.equal(await run([...argv], cli.deps), 1, argv.join(" "));
    const lines = cli.err.join("\n").split("\n");
    assert.equal(lines.length, 2, argv.join(" "));
    assert.match(lines[0]!, /^error: /, argv.join(" "));
    assert.equal(lines[1], hint, argv.join(" "));
  }
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
  assert.match(cli.err.join("\n"), /^error: command-argument value '\.\.' is invalid for argument 'roadId'\. "\." and "\.\." are not ids\./);
});

test("a road id with / exits 1 without a request instead of printing another road's data", async () => {
  const cli = makeCli(() => jsonResponse({ roadworks: [{ identifier: "a" }] }));
  const code = await run(["--compact", "roadworks", "list", "A1/../A2"], cli.deps);
  assert.equal(code, 1);
  assert.equal(cli.mt.calls.length, 0);
  assert.deepEqual(cli.out, []);
  assert.match(cli.err.join("\n"), /is invalid for argument 'roadId'\. An id cannot contain "\/"/);
});

test("a 2xx body without the service envelope exits 1 instead of printing []", async () => {
  const cli = makeCli(() => jsonResponse({ roadworks: "oops", error: "down" }));
  const code = await run(["--compact", "roadworks", "list", "A1"], cli.deps);
  assert.equal(code, 1);
  assert.deepEqual(cli.out, []);
  assert.equal(
    cli.err.join("\n"),
    "Error: Unexpected response shape from https://verkehr.autobahn.de/o/autobahn/A1/services/roadworks: expected a JSON object with a roadworks array.",
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

test("an empty listing whose road-list check fails exits 1 and says the check failed", async () => {
  const cli = makeCli((req) =>
    new URL(req.url).pathname === "/o/autobahn/" ? jsonResponse({ message: "boom" }, 500) : jsonResponse({ warning: [] }),
  );
  assert.equal(await run(["--compact", "warnings", "list", "A2"], cli.deps), 1);
  assert.deepEqual(cli.out, []);
  assert.equal(
    cli.err.join("\n"),
    'Error: Could not check road id "A2" against the API\'s road list (the warning listing was empty): HTTP 500 for GET https://verkehr.autobahn.de/o/autobahn/: boom',
  );
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

test("parse and shape errors name the host that answered, credentials redacted", async () => {
  const cli = makeCli(() => rawResponse("<html>maintenance</html>", "text/html"));
  const code = await run(["--base-url", "https://user:s3cret@mirror.example/api", "roads"], cli.deps);
  assert.equal(code, 1);
  assert.equal(
    cli.err.join("\n"),
    'Error: Failed to parse JSON response from https://***@mirror.example/api/o/autobahn/: expected JSON, got Content-Type "text/html"',
  );
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
    assert.match(cli.err.join("\n"), /^Error: Unexpected response shape from https:\/\/verkehr\.autobahn\.de\/o\/autobahn\//, argv.join(" "));
  }
});

test("credentials in --base-url are redacted from error messages", async () => {
  const cli = makeCli(() => jsonResponse({ message: "boom" }, 500));
  const code = await run(["--base-url", "http://user:s3cret@127.0.0.1:18103/s500", "roads"], cli.deps);
  assert.equal(code, 1);
  // ...but still sent: the request URL keeps the userinfo (Node turns it into Basic auth).
  assert.equal(cli.mt.last().url, "http://user:s3cret@127.0.0.1:18103/s500/o/autobahn/");
  assert.equal(cli.err.join("\n"), "Error: HTTP 500 for GET http://***@127.0.0.1:18103/s500/o/autobahn/: boom");
});

test("--max-retries is bounded to 0..10", async () => {
  for (const [value, code] of [["0", 0], ["10", 0], ["11", 1], ["9007199254740991", 1]] as const) {
    const cli = makeCli(() => jsonResponse({ roads: ["A1"] }));
    assert.equal(await run(["--max-retries", value, "roads"], cli.deps), code, value);
    if (code !== 0) {
      assert.equal(cli.mt.calls.length, 0, value);
      assert.match(cli.err.join("\n"), /from 0 to 10/, value);
    }
  }
});

test("--user-agent that is blank or has control or non-Latin-1 characters is a usage error", async () => {
  const CR = String.fromCharCode(0x0d);
  const LF = String.fromCharCode(0x0a);
  for (const [ua, message] of [
    [`a${CR}${LF}X-Evil: 1`, /Value contains control characters\./],
    [`a${String.fromCharCode(0x7f)}`, /Value contains control characters\./],
    ["agent \u20ac", /Value contains characters outside Latin-1/],
    ["", /Expected a non-empty value/],
    ["   ", /Expected a non-empty value/],
  ] as const) {
    const cli = makeCli(() => jsonResponse({ roads: ["A1"] }));
    const code = await run(["--user-agent", ua, "roads"], cli.deps);
    assert.equal(code, 1, JSON.stringify(ua));
    assert.equal(cli.mt.calls.length, 0, JSON.stringify(ua));
    assert.match(cli.err.join("\n"), message, JSON.stringify(ua));
  }
  const cli = makeCli(() => jsonResponse({ roads: ["A1"] }));
  assert.equal(await run(["--user-agent", "müller-bot/1.0\t(test)", "roads"], cli.deps), 0);
  assert.equal(cli.mt.last().headers?.["User-Agent"], "müller-bot/1.0\t(test)");
});

test("an empty body is not-found (exit 4) only for get; on roads/list it is a parse error (exit 1)", async () => {
  for (const [argv, code, message] of [
    [["roadworks", "get", "x"], 4, /^Error: Not found: the API answered HTTP 20[04] with an empty body for GET \S+\/o\/autobahn\/details\/roadworks\/x$/],
    [["roads"], 1, /^Error: Empty response body from https:\/\/verkehr\.autobahn\.de\/o\/autobahn\/$/],
    [["roadworks", "list", "A1"], 1, /^Error: Empty response body from https:\/\/verkehr\.autobahn\.de\/o\/autobahn\/A1\/services\/roadworks$/],
  ] as const) {
    for (const status of [200, 204]) {
      const cli = makeCli(() => rawResponse("", "application/json", status));
      assert.equal(await run([...argv], cli.deps), code, `${argv.join(" ")} ${status}`);
      assert.match(cli.err.join("\n"), message, `${argv.join(" ")} ${status}`);
    }
  }
});

test("bidi formatting characters in server data are escaped in the JSON output", async () => {
  const bidi = String.fromCharCode(0x202e, 0x2066, 0x200f, 0x061c);
  const served = { identifier: "x", title: `A1${bidi}live` };
  for (const format of [[], ["--compact"]]) {
    const cli = makeCli(() => jsonResponse(served));
    assert.equal(await run([...format, "warnings", "get", "x"], cli.deps), 0);
    const text = cli.out.join("\n");
    assert.ok(!/[\u202e\u2066\u200f\u061c]/.test(text), format.join(" "));
    assert.match(text, /A1\\u202e\\u2066\\u200f\\u061clive/);
    assert.deepEqual(JSON.parse(text), served);
  }
});

test("an AutobahnValidationError raised in an action is a usage error: exit 1, 'Error: <message>'", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const client = new AutobahnClient({ transport: makeMockTransport(() => jsonResponse({})).transport });
  client.roads = async () => {
    throw new AutobahnValidationError("Invalid roadId: Expected a non-empty value.");
  };
  const code = await run(["roads"], {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    createClient: () => client,
  });
  assert.equal(code, 1);
  assert.deepEqual(out, []);
  assert.deepEqual(err, ["Error: Invalid roadId: Expected a non-empty value."]);
});

test("commander's 'Did you mean' hint stays on its own line", async () => {
  for (const [argv, first, hint] of [
    [["roadwork"], "error: unknown command 'roadwork'", "(Did you mean roadworks?)"],
    [["--no-compact", "roads"], "error: unknown option '--no-compact'", "(Did you mean --compact?)"],
    [["roadworks", "lst", "A1"], "error: unknown command 'lst'", "(Did you mean list?)"],
  ] as const) {
    const cli = makeCli(() => jsonResponse({}));
    assert.equal(await run([...argv], cli.deps), 1, argv.join(" "));
    const lines = cli.err.join("\n").split("\n");
    assert.deepEqual(lines.slice(0, 2), [first, hint], argv.join(" "));
    assert.doesNotMatch(cli.err.join("\n"), /\\u000a/, argv.join(" "));
  }
  // A value that mimics the hint is commander-quoted, so it stays escaped.
  const forged = makeCli(() => jsonResponse({}));
  await run(["bogus\n(Did you mean roads?)"], forged.deps);
  assert.match(forged.err.join("\n"), /^error: unknown command 'bogus\\u000a\(Did you mean roads\?\)'/);
});

test("ids echoed in error messages carry no raw control, C1 or bidi characters", async () => {
  const RLO = String.fromCharCode(0x202e);
  const ESC = String.fromCharCode(0x1b);
  // Rejected by the parser: commander repeats the argument.
  const rejected = makeCli(() => jsonResponse({ roadworks: [] }));
  assert.equal(await run(["roadworks", "list", `A1/${RLO}x\nError: forged${ESC}[2J`], rejected.deps), 1);
  const rejectedErr = rejected.err.join("\n");
  assert.match(rejectedErr, /value 'A1\/\\u202ex\\u000aError: forged\\u001b\[2J' is invalid/);
  // Accepted, then echoed by the library (an identifier the API answers about another item).
  const unknown = makeCli(() => jsonResponse({ identifier: "x" }));
  assert.equal(await run(["roadworks", "get", `A1${RLO}evil`], unknown.deps), 1);
  assert.match(unknown.err.join("\n"), /asked for identifier "A1\\u202eevil", got "x"\.$/);
  for (const err of [rejectedErr, unknown.err.join("\n")]) {
    assert.doesNotMatch(err, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e]/u);
    assert.doesNotMatch(err, /^Error: forged/m);
  }
});

test("redactUserinfo hides the userinfo of every URL in a line and leaves other text alone", () => {
  assert.equal(
    redactUserinfo("argument 'ftp://user:s3cret@h.example' is invalid; also http://a@b@c.example/x?y=u@v"),
    "argument 'ftp://***@h.example' is invalid; also http://***@c.example/x?y=u@v",
  );
  assert.equal(redactUserinfo("error: unknown option '--bogus' (mail@example.org)"), "error: unknown option '--bogus' (mail@example.org)");
});

test("a rejected --base-url keeps its usage error but not its credentials", async () => {
  const cli = makeCli(() => jsonResponse({ roads: ["A1"] }));
  assert.equal(await run(["--base-url", "ftp://user:s3cret@h.example", "roads"], cli.deps), 1);
  assert.equal(cli.mt.calls.length, 0);
  assert.equal(
    cli.err[0],
    "error: option '--base-url <url>' argument 'ftp://***@h.example' is invalid. " +
      'Unsupported scheme "ftp:". Expected an http(s) URL.',
  );
});
