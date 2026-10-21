# Developing & integrating

This document covers `autobahn-cli` as a **TypeScript library**, plus its
architecture, testing and release setup. If you just want to use the
command-line tool, start with the **[README](README.md)** and
**[Usage.md](Usage.md)** instead.

The package ships both a CLI (`autobahn`) and a typed API client
(`AutobahnClient`) for the
[Autobahn App API](https://autobahn.api.bund.dev/) (`verkehr.autobahn.de`).

**Design goals**

- **Zero runtime HTTP dependencies** — built on Node's built-in `http`/`https` (no axios, no fetch polyfill).
- **One small dependency** for the CLI: [`commander`](https://github.com/tj/commander.js).
- **Strongly typed** — typed client surface and response shapes.
- **Well tested** — unit tests on Node's built-in test runner (`node --test`), every HTTP response mocked.

## Build from source

```bash
npm install
npm run build        # compiles every workspace (tsc -b) to its dist/
```

Run the locally built CLI without a global install:

```bash
node apps/cli/dist/src/cli/index.js --help    # or: npm start -- --help
# or, after `npm link --workspace apps/cli`:
autobahn --help
```

## Library usage

```ts
import { AutobahnClient, AutobahnApiError, AutobahnNotFoundError } from "@maschinenlesbar.org/autobahn-cli";

const client = new AutobahnClient(); // defaults to https://verkehr.autobahn.de

const roads = await client.roads();              // ["A1", "A2", ...]
const works = await client.roadworks.list("A1"); // AutobahnServiceItem[]
const detail = await client.roadworks.get(works[0]!.identifier!); // same service as the list

try {
  await client.closures.get("DOES-NOT-EXIST");
} catch (err) {
  // The API answers an unknown identifier with an empty 200: AutobahnNotFoundError.
  if (err instanceof AutobahnNotFoundError) console.error("no such closure");
  // A non-2xx answer (502, 404, …) is an AutobahnApiError.
  else if (err instanceof AutobahnApiError) console.error(err.status, err.detail);
  else throw err;
}
```

### Client options

```ts
new AutobahnClient({
  baseUrl: "https://verkehr.autobahn.de",
  timeoutMs: 15_000,
  maxRetries: 3,              // 429/502/503/504 and reset connections are retried (honours Retry-After,
                              // else a linear backoff from retryDelayMs; a 429 from 1 s, doubling)
  maxResponseBytes: 50 << 20, // abort responses larger than 50 MiB (0 = unlimited)
  userAgent: "my-app/1.0",
  transport: customTransport, // inject your own HTTP transport
  onWarning: (message) => console.warn(message), // an answer delivered changed (U+FFFD), see below
  bigIntegerKeys: new Set(["_version_"]),      // members whose numbers may pass 2^53: delivered as strings
});
```

**Exact answers.** A number a double can't carry exactly (out of range, past 2^53 in any form,
too small and turned into 0, or a subnormal that prints changed: `3e-324` became `5e-324`) is an
`AutobahnParseError`, never a changed value. A member named in `bigIntegerKeys` (a set or
list of non-empty member names, copied; default none, and the Autobahn API needs none: its
answers carry coordinates and ids as strings) is the one exception: its number value is
delivered as its exact literal, as written, as a JSON string (`"1858054135406919680"`, `"5"`),
whatever its size, so its type is stable. The engine does both in one linear scan of the text
before `JSON.parse` (`scanNumbers`, which quotes the declared values in place; no reviver).
Text is never changed silently either: bytes that aren't valid in the answer's charset and lone
surrogates written as JSON escapes (`\ud800`) become U+FFFD (the result is well-formed, so `jq`
reads the CLI's output), and `onWarning` gets one message naming the count and the request; the
CLI logs it as a `WARN` record of `autobahn.api`. One bad character never sinks a whole
answer.

Every option may be omitted or given as `undefined`, which means the same (the default),
so `new AutobahnClient({ baseUrl: process.env.AUTOBAHN_BASE_URL })` compiles under
`exactOptionalPropertyTypes` too.

`transport` and `sleep` must be functions when given, and an unknown option name (a
JavaScript typo such as `timeout` for `timeoutMs`) is rejected too — both as an
`AutobahnValidationError`. The numeric options must be integers in range — `timeoutMs` 0..2³¹−1, `maxRetries`
0..10 (`MAX_RETRIES`), `retryDelayMs` 0..30 000, `maxResponseBytes` 0..2⁵³−1 — or the
constructor throws an `AutobahnValidationError` naming the option (a negative or `NaN` timeout
no longer silently disables the timeout).

`baseUrl` must pass `baseUrlProblem` (exported): an absolute `http:`/`https:` URL with no
query (`?`) or fragment (`#`), no surrounding whitespace and no control characters. The
engine appends request paths to the raw string, so `"https://h/ "` would otherwise
request `/%20/o/autobahn/`. Anything else makes the constructor throw an
`AutobahnValidationError` (`Invalid option baseUrl: <reason>`) before any request; the
CLI's `--base-url` parser applies the same function, and its default is
`DEFAULT_BASE_URL`. The default `userAgent` is `DEFAULT_USER_AGENT`
(`autobahn-cli/<version> (+https://github.com/maschinenlesbar-org/autobahn-cli)`, both
exported). Only an omitted (`undefined`) `baseUrl` or `userAgent` selects the
default; an empty string is rejected like `"  "`, as the CLI rejects `--base-url ""`.
The reasons never repeat the value. The CLI also redacts on output: `run.ts`
(`redactionFor`, `withRedactedOutput`) takes the exact userinfo of every URL argument and of `AUTOBAHN_BASE_URL`
(`credentialsIn`, exported) and replaces it with `***` in everything it prints — commander's
usage errors, which echo rejected values, its own messages and the help's defaults — so a
password with spaces, quotes, `#`, `?` or `/` is caught as well as an ordinary one. Only a
value that starts with a scheme counts (a bare `a:b@c` is a User-Agent or a road id as often
as a credential), except as the `--base-url` value or `AUTOBAHN_BASE_URL`, where a
`user:password@host` typed without its scheme is still redacted. The
forms a server echoes a userinfo back in are replaced too (`echoedCredentialForms`): the
`Basic` value (UTF-8, as Node sends it) and the decoded `user:password` on stdout and
stderr, the password alone (4 characters or more) on stderr only, since it may well
occur in the data. The engine scrubs the same forms from error bodies, details and
transport text, so `err.message` and `err.body` are clean for library callers too.
`redactUrl` falls back to the same text-based cut for a value that doesn't parse as a URL. `userAgent` follows
`headerValueProblem` (exported too), which the CLI's `--user-agent` parser shares; a
value it rejects throws `AutobahnValidationError` (`Invalid option userAgent: <reason>`).

### Resource groups

`client.roadworks`, `.webcams`, `.parkingLorries`, `.warnings`, `.closures`,
`.chargingStations` — each with `.list(roadId)` and `.get(identifier)`. Plus
`client.roads()` for the motorway list, trimmed, without blank ids and de-duplicated
in the API's order (the API lists both `"A60"` and `"A60 "`; `list()` trims its road id,
so both name the same road). The API answers an unknown road id with an
empty listing, so `list()` checks an empty result against `roads()` (one extra
request) and throws `AutobahnNotFoundError` for an id that is not in it.

## Authentication internals

The Autobahn App API requires **no authentication and no API key**. Every
endpoint under `/o/autobahn` is fully open and read-only. The client attaches
no credential headers of its own. A base URL with userinfo
(`https://user:password@mirror.example`) is the one exception, by design: Node's
`http(s).request` turns it into `Authorization: Basic …` for that host, as `curl` does
(for a mirror behind a login). It never goes elsewhere, since redirects are not
followed, and `redactUrl`/`redactUserinfo` keep it out of every message. `--base-url` is trusted input: the CLI fetches whatever
host you point it at; only `http:`/`https:` URLs are accepted, and redirects
are **not** followed — a `3xx` surfaces as an error rather than being chased to
another host.

A plain-`http:` base URL gets a warning, not a refusal: `cleartextProblem(baseUrl, secrets)`
(engine, exported) returns one sentence naming the host (`url.host`, never the userinfo)
and what travels unencrypted — the base URL's credentials when it carries userinfo — or
`undefined` for `https:`, an unparseable URL and loopback hosts (`localhost`,
`127.0.0.0/8`, `::1`; nothing leaves the machine). The CLI's `action()` wrapper
(`shared.ts`, `warnOnCleartext`) logs it once per run as a `WARN` record of `autobahn.http` on stderr
for the effective base URL (flag > `AUTOBAHN_BASE_URL` > default), after the options are
parsed and before the first request; `--help`, `--version` and usage errors never get
there. (It replaces the CLI-internal `warnOnCleartextCredentials`, which warned only for
userinfo, loopback included.)

## Architecture

The repository is an **npm workspace** with two folders: `apps/` holds the programs it
publishes, `packages/` the libraries they are built from.

```
package.json         # private workspace manifest: no version, never packed
apps/cli/            # @maschinenlesbar.org/autobahn-cli — the published package
  package.json       # its version, bin, files (no workspace package in dependencies)
  src/index.ts       # library entry: re-exports @maschinenlesbar.org/autobahn-client, + VERSION
  src/cli/           # the CLI (below)
  test/              # CLI tests and every conformance-*.test.ts
packages/client/     # @maschinenlesbar.org/autobahn-client — private, shipped inside the CLI's tarball
  src/               # the API client (below)
  test/              # tests that only touch the client, + the transport helpers
tools/pack/          # prepack/postpack: ship the client (dist/node_modules) and commander in the tarball
tools/bump.mjs       # version bump + commit + tag (npm run bump)
tsconfig.docs.json   # TypeDoc only: the package entry, with the client read from its sources
```

- **The client is its own package** so a later MCP app can share it with the CLI. It is
  never published on its own: `apps/cli`'s `prepack` copies it into
  `apps/cli/dist/node_modules/`, where the CLI's imports find it, and the tarball ships it
  as plain files — so npm lists only commander (bundled) as a dependency, never the
  private client. `apps/cli/package.json` therefore doesn't name the client; prepack finds
  it through `apps/cli/tsconfig.json`'s project references. The library
  entry re-exports the client's `"."`, so `import { AutobahnClient } from
  "@maschinenlesbar.org/autobahn-cli"` is unchanged.
- **The client's exports:** `"."` is the public library surface (`src/index.ts`);
  `"./internal/*"` maps to any module (`…/autobahn-client/internal/engine`) for what the
  CLI needs beyond that; `"./test/*"` reaches the client's test helpers from the CLI's
  tests (not bundled). Only `"."` is part of the library.
- **Dependencies point one way:** the app depends on the client, the client on nothing
  in the workspace.
- **The version lives in `apps/cli/package.json`** and belongs to the CLI: `version.ts` is
  in `apps/cli/src/cli/`, the library entry exports its `VERSION`, and the CLI sends
  `autobahn-cli/<version> (+https://github.com/maschinenlesbar-org/autobahn-cli)` as its
  User-Agent (`USER_AGENT`, handed to the client by `defaultDeps.createClient`). The client
  has no release version of its own; its `DEFAULT_USER_AGENT`, sent by a library user who
  sets no `userAgent`, names the project without one. The root has no version; a plain
  `npm version` at the root is refused. Release with `npm run bump -- <patch|minor|major>`,
  which bumps the app, commits (the bare version as the message) and tags `vX.Y.Z`.
- **TypeScript:** `tsconfig.base.json` holds the compiler options; every workspace has a
  `tsconfig.json` (`src/`) and a `tsconfig.test.json` (`test/`), and the root
  `tsconfig.json`/`tsconfig.test.json` reference them, built with `tsc -b`.

The client (`packages/client/src/`) and the CLI (`apps/cli/src/`):

```
packages/client/src/
    types.ts     # response interfaces (typed list items; details as JsonObject)
    query.ts     # dependency-free query-string builder
    http.ts      # the Transport interface + default node:http/https transport
    engine.ts    # URL building, retry/backoff, JSON/raw decoding, error mapping
    errors.ts    # AutobahnError / AutobahnApiError / AutobahnNetworkError / AutobahnParseError / AutobahnValidationError
    validate.ts  # the Problem type + assertValid(): input rules shared by library and CLI
    client.ts    # AutobahnClient — a generic ServiceResource per service group
    index.ts     # the client's public surface (the library entry re-exports it)
apps/cli/src/cli/
    version.ts   # VERSION from apps/cli/package.json (--version, the library entry) + USER_AGENT
    io.ts        # injectable I/O seam (stdout/stderr), the logger and the clock
    log.ts       # the stderr log: records with ts, level, topic; --log-format text|jsonl
    shared.ts    # option parsers (one value each: forbidRepeatedOptions), global-option resolver
    output.ts    # the JSON renderer: control characters escaped, a too-deep answer an OutputError
    commands/    # roads + the six service command groups
    program.ts   # assembles the commander program from injectable deps
    run.ts       # parses argv -> exit code (no process.exit; testable)
    index.ts     # #! bin shim
```

**Design notes**

- The HTTP layer is a single `Transport` function (`(req) => Promise<HttpResponse>`). The default
  uses `node:http`/`node:https`; tests inject a mock. This keeps the client free of any HTTP framework.
- The CLI is built around injectable `CliDeps` (client factory + I/O), so the whole program can be
  driven in-process by tests with a mocked client and captured output — no subprocesses.
- The six services share one generic `ServiceResource`, so adding a service is a one-line change.

### Library / technical terms

**API client.** [`AutobahnClient`](packages/client/src/client.ts) — the typed,
service-grouped wrapper over the API. Usable as a library independently of the
CLI; defaults to `https://verkehr.autobahn.de`.

**Service resource.** A `ServiceResource` exposing `.list(roadId)` and
`.get(identifier)` for one service. The client exposes six:
`client.roadworks`, `.webcams`, `.parkingLorries`, `.warnings`, `.closures`,
`.chargingStations`, plus the standalone `client.roads()`.

**Transport.** A single function `(HttpRequest) => Promise<HttpResponse>`
([`http.ts`](packages/client/src/http.ts)). The default uses Node's built-in
`http`/`https`; tests inject a mock. This is the only HTTP seam.

**Request engine.** [`RequestEngine`](packages/client/src/engine.ts) — builds URLs,
serialises queries, applies retry/backoff, decodes JSON responses (by the
Content-Type charset, UTF-8 by default, a leading BOM dropped) and maps
errors. Sits between the client's resource methods and the transport.

**RawResponse.** The low-level result of a request: `{ data: Buffer,
contentType, status }` — raw bytes plus metadata, before JSON decoding.

**Query-string builder.** [`query.ts`](packages/client/src/query.ts) — a dependency-free
serialiser: omits `undefined`/`null`, repeats keys for arrays (`?id=a&id=b`),
renders booleans as `"true"`/`"false"`, dates as ISO-8601, and encodes spaces as
`%20`.

**CliDeps / CliIO.** The dependency-injection seam for the CLI
([`io.ts`](apps/cli/src/cli/io.ts)): a client factory, an I/O object (`out`/`err`) and the
environment (`env`, read for `AUTOBAHN_BASE_URL`; tests pass `{}`).
Lets the whole CLI run in tests with a mocked client and captured output — no
subprocess.

**Error types.** [`errors.ts`](packages/client/src/errors.ts): `AutobahnApiError`
(non-2xx, carries `status`/`detail`/`url`/`body`; `detail` is sanitised and cut at
500 characters, `body` is the full text; the message also cuts the URL at 500
characters, `url` keeps it whole; a cut never splits a surrogate pair (`cutText`), so the
message stays well-formed), `AutobahnNetworkError`
(transport failure/timeout, including anything an injected transport throws, raised as
`GET <url> failed: <reason>` — the URL redacted, `(after N retries)` when a reset was
retried — with the original as `cause` — never a configuration error: a bad `baseUrl` or
`userAgent`, a numeric option out of range or a blank, `.`/`..` or `/`-containing road
id or identifier throws an `AutobahnValidationError` before any request),
`AutobahnParseError` (bad JSON, an empty body, an unknown charset or a compressed
body, a 2xx body without the expected shape, a detail about another identifier, or a number
JSON.parse can't carry exactly — out of a double's range, past 2^53 in any written form, too
small and turned into 0, or a subnormal (below 2.2250738585072014e-308) that does not print as
written, `3e-324` becoming `5e-324`; below 2^53 and above the subnormal range a decimal
fraction keeps a double's precision, as JSON means it; past 2^53 and below the normal range
the number as printed, `String(value)`, is compared with the number as written, so
`12345678901234567890`, which prints as `12345678901234567000`, is refused, while `1e23` or
`1.7976931348623157E308`, a double a server printed in its own shortest form, passes). Every
error about an answer names the request like a network error does: `GET <url>: …`, the full
request URL with userinfo redacted and cut at 500 characters (`GET <url>: the answer is not
valid JSON (expected JSON, got Content-Type "text/html").`, `GET <url>: empty response body.`,
`GET <url>: unexpected response shape: expected …`, `GET <url>: asked for identifier "…", got
"…".`, `GET <url>: the number … cannot be represented exactly.`). All extend
`AutobahnError`. `AutobahnNotFoundError` (a road id the API does not know, or an
identifier the detail endpoint answers with an empty body; CLI exit `4`) extends
`AutobahnError` too — it is not an `AutobahnApiError`.

**Input validation.** [`validate.ts`](packages/client/src/validate.ts): a rule is a pure
`<thing>Problem(value)` function that returns why a value is invalid, or `undefined`.
The library enforces it with `assertValid(name, value, problem)` before any request,
which throws `AutobahnValidationError` (extends `AutobahnError`, exported) with the
message `Invalid <name>: <reason>`; a method that returns a promise rejects with it. The
CLI's option and argument parsers call the same `…Problem` functions (`parseId` wraps
`idProblem` for the `<roadId>`/`<identifier>` arguments), so an input gets the same
outcome on both sides, and `run.ts` reports an `AutobahnValidationError` raised in an
action as a usage error (an `ERROR` record of `autobahn.cli`, exit `2`, like commander's own parse errors).

**Retry / backoff.** Transient `429` (rate-limited), `503` (service
unavailable) and the gateway errors `502`/`504` are retried automatically with backoff, up to `maxRetries`
(default `2`). The backoff is linear from `retryDelayMs` (200 ms) — except for a `429`,
which waits from 1 s, doubling per retry (at most 30 s). A `Retry-After` header (both
delta-seconds and HTTP-date forms) can make a wait longer, clamped to a 30s ceiling so a
pathological value cannot hang the CLI, but never shorter: `Retry-After: 0` or a date in
the past still waits the backoff, so retries never burst.
`AutobahnApiError.isRetryable` reflects this. A reset connection
(`isTransientNetworkError`: `ECONNRESET`/`EPIPE`/`ECONNABORTED` as the network error's
`cause`) is retried with the linear backoff too. Only `GET` and `HEAD` are retried: a
caller of the public `RequestEngine.request` with another method gets one attempt.

Each retry is announced: the engine option `onRetry(event: RetryEvent)` (exported type:
`{ retry` (1-based), `maxRetries`, `delayMs`, `status?` (absent for a reset), `url` (userinfo
redacted) `}`) is called once per retry right before the sleep, never when there is none, and
a throw in it is swallowed. The CLI's `action()` sets it to log one `WARN` record of
`autobahn.http`, `HTTP 503 from <host>: retry 1 of 3 in 2 s` (`retryMessage`; host only, whole
seconds, ms under 1 s). Tests: `test/retry-log.test.ts`.

**`maxResponseBytes`.** A hard cap on response body size (default 100 MiB;
`0` disables) that defends against memory exhaustion from a hostile or buggy
endpoint. The default transport aborts as soon as the cap is passed; the engine also
checks the body any transport returns, so the cap holds for custom transports too.

**Custom transports.** A transport may return the body as a Buffer, any `ArrayBuffer`
view (fetch's `Uint8Array`, from any realm) or an `ArrayBuffer`, and the headers as a plain
record in any case, a `Headers` object or a `Map`. Whatever it throws becomes an
`AutobahnNetworkError`; a reset reported as Node's `ECONNRESET`/`EPIPE`/`ECONNABORTED` or
undici's `UND_ERR_SOCKET` anywhere in the `cause` chain is retried like a 502.

**`timeoutMs`.** Bounds a request two ways (default 30s; `0` disables): a
socket-inactivity timeout *and* an overall wall-clock deadline armed at request
start. The deadline stops a slow-drip endpoint that resets the inactivity timer
forever (one byte at a time) from holding the CLI open under the size cap. The engine
enforces the deadline itself, for every transport: the transport gets an `AbortSignal`
(`HttpRequest.signal`) that fires at the deadline, and the call rejects then whether the
transport stops or not, so a `fetch` or `node:http` transport can't hang a caller.

**Empty-body not-found.** The detail endpoint answers an unknown identifier with
HTTP 200 and an empty body rather than a true `404`. For `get` (the engine's
`getJson(..., { emptyIsNotFound: true })`) an empty (or whitespace-only) body is
not-found: an `AutobahnNotFoundError` naming the status the server really sent (CLI
exit `4`) — not an `AutobahnApiError` with an invented `404` — instead of a misleading
parse error. Everywhere else an empty body raises
`AutobahnParseError` (`GET <url>: empty response body.`, exit `1`).

## Testing

```bash
npm test          # builds, then runs `node --test` over each workspace's dist/test
npm run coverage  # the same tests in one run, with a coverage report
node --test apps/cli/dist/test/cli.test.js   # one file, after a build
```

The client's tests are in `packages/client/test/` (`query`, `http`, `engine`, `client`,
`types`), everything that drives the CLI is in `apps/cli/test/`.

- **`query.test.ts`** — query-string serialisation.
- **`http.test.ts`** — the default transport against a real loopback `http.createServer`.
- **`engine.test.ts`** — URL building, JSON decoding, error mapping, 429/502/503/504 retry — mocked transport.
- **`client.test.ts`** — every resource's method/URL mapping — mocked transport.
- **`validate.test.ts`** — `assertValid` and the `parity()` helper (`apps/cli/test/helpers.ts`), which sends one input through `run()` and through the library, each on a recording mock transport, so a test can assert both give the same outcome.
- **`shared.test.ts`** — option parsing (`parseIntArg`) and `toEngineOptions` mapping.
- **`cli.test.ts`** — end-to-end command parsing, rendering, error/exit codes and option flow-through — mocked client.
- **`parity.test.ts`** — CLI ↔ library parity: the same input through `run()` and through the library must give the same outcome (both reject without a request with the same reason, or both send the same requests).
- **`io.test.ts`** — the default I/O seam: EPIPE and other stdout/stderr write errors.
- **`output.test.ts`** — the renderer: an answer too deep or too large to print (the cause named, "try --compact" only where `--compact` prints it, probed on the runtime), and which `JSON.stringify` path `--compact` takes (the gap path only for a string or key of 64 Mi characters or more).
- **`log.test.ts`** — the record helpers of `apps/cli/src/cli/log.ts` on their own
  (`escapeForRecord`, `formatLogRecord`); the CLI-level checks are P23's.
- **`types.test.ts`** — compile-time checks of exported library types (e.g. `ServiceResource`), and a consumer file compiled by `tsc` with `exactOptionalPropertyTypes` that passes `undefined` for every option (it starts a process: 30 s).
- **`conformance-p*.test.ts`** — the checks shared across the `*-cli` repos, the same files
  everywhere with only an adapter block at the top: P1 CLI redaction, P2 library
  redaction, P4/P19 configuration validation, P5 the transport contract, P6 the retry
  policy, P7 pipes and exit codes (runs the built bin), P8/P9/P13 charset, response
  shapes and error classes, P20 the stderr warning for a plain-`http:` base URL (its
  other-secret case is skipped: the API takes no key), P21 the README's relative links
  (README.md ships to npmjs.com, so a link to a document the `files` allowlist leaves out
  must be an absolute GitHub URL), P23 the log records on stderr and `--log-format`, P24 the
  input corpus (every id that goes into a path is sent trimmed or refused, on the CLI and in the
  library alike; the API takes no free text, so its text-filter case has no inputs), P25 the
  response corpus (a number a double can't carry, or an empty listing, is an error, never a
  changed value; a subnormal that prints changed too; the error names the request), P26 (`-o`
  integrity) does not apply: autobahn has no `-o`, P27 big and odd answers (a large flat answer
  and one of DEL characters print within a small heap, or are "too large" past V8's longest
  string; a lone surrogate or invalid bytes become U+FFFD with a `WARN` record of
  `autobahn.api`). Mock transports or local servers only, never the live
  API.
- **`package.test.ts`** — the published package: `npm pack --dry-run` in `apps/cli` must list the library, the bin and `version.js`, and no sources, tests, maps, skills or site; the documents `prepack` copies in (README, LICENSE, the licence documents) must exist at the root and be shipped, and every dependency must be bundled. (The dry run skips `prepack`: running it during the tests would put the bundled copies in front of the workspace links. CI packs and installs the real tarball.)

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 22/24/26 for every push and PR; then pack the
  real tarball, check the pack left nothing behind, install it globally with the registry out
  of reach and run the bin.
- **release.yml** — on a `v*` tag (made by `npm run bump`): verify the tag matches `apps/cli/package.json`, test, write the SBOMs (scoped to the `apps/cli` workspace), then `npm pack --workspace apps/cli`, and create a GitHub Release with the tarball. The release notes come from the Conventional-Commit subjects since the previous tag (`.github/scripts/changelog.mjs`); mark a change a script or library caller must adapt to with `type!:` or a `BREAKING CHANGE: <what to do>` footer, and it is also listed under **Behaviour changes** at the top. A change that wasn't marked when committed can still be listed: put a `BREAKING CHANGE:` footer per change into the release commit (the bare version commit `npm run bump` makes is left out of the type groups, but its footers are read).
- **publish.yml** — manual dispatch from the release tag (`gh workflow run publish.yml --ref vX.Y.Z`; the version is the tag's): `npm publish --workspace apps/cli` via OIDC **Trusted Publishing** (no stored `NPM_TOKEN`) with provenance.
- **docs.yml** — build the project website (`site/`, English and German) with the TypeDoc API docs
  under `/api/`, and deploy both to GitHub Pages on each `v*` tag.
  TypeDoc runs from the isolated, lockfile-pinned `tools/docs/` toolchain because it
  needs the TypeScript 6 compiler API, which TypeScript 7 no longer ships; locally,
  run `npm ci --prefix tools/docs` once before `npm run docs`.

## Website

The project website — <https://maschinenlesbar.org/autobahn-cli/> in English and
<https://maschinenlesbar.org/autobahn-cli/de/> in German — is built from `site/` with
[Jekyll](https://jekyllrb.com/), [banira](https://sebs.github.io/banira/) web components and
[Fylgja](https://fylgja.dev/) CSS, and deployed by `docs.yml` together with the TypeDoc API
reference under `/api/`. Its content comes from this repository: the README intro and quick
start, the command tree of the built CLI (`site/scripts/cli-reference.mjs`), `Usage.md`,
`GLOSSARY.md` and its German version `GLOSSARY.de.md`, the skills, and the skill examples in
`EXAMPLE.md` and `EXAMPLE.de.md`. The only repo-specific files are `site/_config.yml` (which
also says where the published manifest and the built program are: `manifest:
apps/cli/package.json`, `program: apps/cli/dist/src/cli/program.js`) and
`site/_data/project.yml` (the German intro and the access requirements); the rest of `site/` is
identical in every maschinenlesbar.org CLI, so change it in all of them together. When the
README intro changes, update the German intro in `site/_data/project.yml`.

The build also writes `sitemap.xml`: every page in both languages, and `/api/`. Crawlers
find it through `robots.txt` at the root of maschinenlesbar.org, which only the
organisation website can serve; its `site/_data/sites.yml` lists every site's sitemap, so a
new CLI gets a line there.

```bash
npm run build                        # the CLI, for the command reference
cd site && npm ci && bundle install  # once (Node >= 22.12, Ruby 3.4, Bundler)
npm run serve                        # http://127.0.0.1:4000/autobahn-cli/
```

## License

Dual-licensed under **[AGPL-3.0-or-later](LICENSE)** or a commercial license — see
**[LICENSING.md](LICENSING.md)**. This project does **not** accept external code
contributions; see **[CONTRIBUTING.md](CONTRIBUTING.md)**.

## The log on stderr

Every diagnostic line on stderr is a log record (`apps/cli/src/cli/log.ts`): a timestamp, a level
(`ERROR`, `WARN`, `INFO`) and a topic, `autobahn.<area>`. `--log-format text` (the default)
writes it log4j style, `<ISO 8601 UTC> <LEVEL padded to 5> [<topic>] <message>`;
`--log-format jsonl` writes one JSON object per line with exactly `ts`, `level`, `topic`
and `msg`. A record is always one line: `formatLogRecord` runs `escapeForRecord` over
the message (text) or the whole JSON object (jsonl), which writes CR and LF as `\r`/`\n`,
every other C0 control but TAB, DEL and C1 as `\u00XX`, and U+2028, U+2029 and the bidi
controls as `\uXXXX`, so no text that reaches a record, by whatever path, can split it,
forge another one or steer the terminal. Before that a lone surrogate (half a
character, which jq rejects, stopping the whole stream) becomes U+FFFD (`toWellFormed`),
and a message longer than `MAX_RECORD_MESSAGE` (4000 characters, exported) is cut at a
code point and ends in `… (N more characters)`. Own messages cut a value they quote at
the source too, at `MAX_MESSAGE_VALUE_LENGTH` (500, `cutForMessage`, `quoteValue`), so a
library caller's `err.message` is bounded as well. The areas are `cli` (usage errors — commander's and the CLI's own pre-parse
checks — the `(run "… --help" for usage)` pointer after them as `INFO`, other errors and
unexpected ones), `api` (the API's answers: an HTTP error, an unknown road id or
identifier, and a malformed answer — an `AutobahnParseError`: bad JSON, the wrong shape or
content type, an empty body, a detail about another identifier — as well as a listing
that answered 404 and a failed road-list check, which take the area of their cause:
`areaOf` in `run.ts`), `http` (network errors, the cleartext warning) and `output` (a failed write
to stdout, an answer it can't print: `OutputError`, exit 1, naming the cause — "nested too
deeply" for a stack overflow, "too large" for a text past V8's longest string (2^29 − 24
characters); "try --compact" is added only when the compact form of that very answer prints,
probed, since whether compact output survives deep nesting depends on the Node version and the
machine's stack. `holdsHugeString`, which picks the compact path, walks the answer iteratively
without an allocation per value. `escapeControlChars` writes DEL, C1 and the bidi controls as
`\uXXXX`; it measures the escaped length first (past V8's longest string the answer is "too
large to print (N characters once its control characters are escaped)") and builds the text in
64 Ki chunks, so an answer of DEL characters prints within memory). Code logs through
`logOf(deps)` and never writes diagnostics with `io.err` directly. `run()` builds the
logger from argv before commander parses it (`logFormatFromArgv`, which skips the value of
one of the program's own value options, as commander does (`valueOptionsOf`: a subcommand's
value option does not count, since commander takes the program's options out of argv first); used only for the records of a parse
error: the program's first `preAction` hook then sets the format commander parsed, so
`--user-agent --log-format=jsonl` logs text), with the run's redaction
(`redactionFor`, `withRedactedOutput`), which replaces a secret in the message only,
before it is escaped, and writes the record to the raw stderr: the frame is never
touched, and a secret is kept out of the log in either format, also one that holds DEL,
C1 or bidi characters. commander's own output is buffered and
flushed once the outcome is known (`flush` in `run.ts`): help shown for a bare invocation
goes to stdout as it is, and on stderr it is one record per line (`commanderRecords`):
commander's `error: …` an `ERROR` record of `autobahn.cli`, with a `(Did you mean …?)`
line joined to it, and anything else (the `(run "… --help" for usage)` pointer) an
`INFO` record per non-blank line. A bare `autobahn` with no arguments shows its help on stdout and exits 0; a command group or
global options without a command log an `ERROR` "missing command: `autobahn roadworks
<subcommand>`" first, then the help as `INFO` records, and exit 2, so there is no failed run
without an `ERROR` record. `CliDeps.now` makes the timestamps
testable. stdout carries data only. A failed write to stdout other than a closed pipe
(EPIPE/ENOTCONN, which exits 0 quietly) is an `ERROR` record of `autobahn.output`
(`Could not write to stdout: …`) and exits 1: the bin shim's `handleOutputErrors` logs it
outside `run()`, through `processLogger(argv)`, in the format argv asks for and with the
run's redaction. Node's own process warnings (`NODE_TLS_REJECT_UNAUTHORIZED=0`) are
`WARN` records of `autobahn.cli` too: the bin shim installs `installWarningLog`, which
removes Node's default `warning` listener and logs `(node) <name>: <message>` through the
same `processLogger(argv)`. In `defaultIO` a record waits for stdout
(`stderrAfterStdout`): it is held while stdout has a backlog and written, in order, once
it is gone, so with `2>&1 |` and a slow reader it never lands inside the data.
Conformance test P23 checks all of this, and its body is shared across the *-cli repos.
