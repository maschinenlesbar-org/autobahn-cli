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
npm run build        # compiles TypeScript to dist/
```

Run the locally built CLI without a global install:

```bash
node dist/src/cli/index.js --help
# or, after `npm link`:
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
});
```

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
(`withRedactedOutput`) takes the exact userinfo of every argument and of `AUTOBAHN_BASE_URL`
(`credentialsIn`, exported) and replaces it with `***` in everything it prints — commander's
usage errors, which echo rejected values, its own messages and the help's defaults — so a
password with spaces, quotes, `#`, `?` or `/` is caught as well as an ordinary one.
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

```
src/
  client/
    types.ts     # response interfaces (typed list items; details as JsonObject)
    query.ts     # dependency-free query-string builder
    http.ts      # the Transport interface + default node:http/https transport
    engine.ts    # URL building, retry/backoff, JSON/raw decoding, error mapping
    errors.ts    # AutobahnError / AutobahnApiError / AutobahnNetworkError / AutobahnParseError / AutobahnValidationError
    validate.ts  # the Problem type + assertValid(): input rules shared by library and CLI
    client.ts    # AutobahnClient — a generic ServiceResource per service group
    version.ts   # VERSION from package.json (the CLI's --version and the default User-Agent)
  cli/
    io.ts        # injectable I/O seam (stdout/stderr), the logger and the clock
    log.ts       # the stderr log: records with ts, level, topic; --log-format text|jsonl
    shared.ts    # option parsers, global-option resolver, JSON renderer
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

**API client.** [`AutobahnClient`](src/client/client.ts) — the typed,
service-grouped wrapper over the API. Usable as a library independently of the
CLI; defaults to `https://verkehr.autobahn.de`.

**Service resource.** A `ServiceResource` exposing `.list(roadId)` and
`.get(identifier)` for one service. The client exposes six:
`client.roadworks`, `.webcams`, `.parkingLorries`, `.warnings`, `.closures`,
`.chargingStations`, plus the standalone `client.roads()`.

**Transport.** A single function `(HttpRequest) => Promise<HttpResponse>`
([`http.ts`](src/client/http.ts)). The default uses Node's built-in
`http`/`https`; tests inject a mock. This is the only HTTP seam.

**Request engine.** [`RequestEngine`](src/client/engine.ts) — builds URLs,
serialises queries, applies retry/backoff, decodes JSON responses (by the
Content-Type charset, UTF-8 by default, a leading BOM dropped) and maps
errors. Sits between the client's resource methods and the transport.

**RawResponse.** The low-level result of a request: `{ data: Buffer,
contentType, status }` — raw bytes plus metadata, before JSON decoding.

**Query-string builder.** [`query.ts`](src/client/query.ts) — a dependency-free
serialiser: omits `undefined`/`null`, repeats keys for arrays (`?id=a&id=b`),
renders booleans as `"true"`/`"false"`, dates as ISO-8601, and encodes spaces as
`%20`.

**CliDeps / CliIO.** The dependency-injection seam for the CLI
([`io.ts`](src/cli/io.ts)): a client factory, an I/O object (`out`/`err`) and the
environment (`env`, read for `AUTOBAHN_BASE_URL`; tests pass `{}`).
Lets the whole CLI run in tests with a mocked client and captured output — no
subprocess.

**Error types.** [`errors.ts`](src/client/errors.ts): `AutobahnApiError`
(non-2xx, carries `status`/`detail`/`url`/`body`; `detail` is sanitised and cut at
500 characters, `body` is the full text; the message also cuts the URL at 500
characters, `url` keeps it whole; a cut never splits a surrogate pair (`cutText`), so the
message stays well-formed), `AutobahnNetworkError`
(transport failure/timeout, including anything an injected transport throws, raised as
`GET <url> failed: <reason>` — the URL redacted, `(after N retries)` when a reset was
retried — with the original as `cause` — never a configuration error: a bad `baseUrl` or
`userAgent`, a numeric option out of range or a blank, `.`/`..` or `/`-containing road
id or identifier throws an `AutobahnValidationError` before any request),
`AutobahnParseError` (bad JSON, or a 2xx body without the
expected shape: `Unexpected response shape from <url>: expected …`, the full request
URL with userinfo redacted), all extending
`AutobahnError`. `AutobahnNotFoundError` (a road id the API does not know, or an
identifier the detail endpoint answers with an empty body; CLI exit `4`) extends
`AutobahnError` too — it is not an `AutobahnApiError`.

**Input validation.** [`validate.ts`](src/client/validate.ts): a rule is a pure
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
`AutobahnParseError` (`Empty response body from <url>`, exit `1`).

## Testing

```bash
npm test          # builds, then runs `node --test` over dist/test
```

- **`query.test.ts`** — query-string serialisation.
- **`http.test.ts`** — the default transport against a real loopback `http.createServer`.
- **`engine.test.ts`** — URL building, JSON decoding, error mapping, 429/502/503/504 retry — mocked transport.
- **`client.test.ts`** — every resource's method/URL mapping — mocked transport.
- **`validate.test.ts`** — `assertValid` and the `parity()` helper (`test/helpers.ts`), which sends one input through `run()` and through the library, each on a recording mock transport, so a test can assert both give the same outcome.
- **`shared.test.ts`** — option parsing (`parseIntArg`) and `toEngineOptions` mapping.
- **`cli.test.ts`** — end-to-end command parsing, rendering, error/exit codes and option flow-through — mocked client.
- **`parity.test.ts`** — CLI ↔ library parity: the same input through `run()` and through the library must give the same outcome (both reject without a request with the same reason, or both send the same requests).
- **`io.test.ts`** — the default I/O seam: EPIPE and other stdout/stderr write errors.
- **`log.test.ts`** — the record helpers of `src/cli/log.ts` on their own
  (`escapeForRecord`, `formatLogRecord`); the CLI-level checks are P23's.
- **`types.test.ts`** — compile-time checks of exported library types (e.g. `ServiceResource`).
- **`conformance-p*.test.ts`** — the checks shared across the `*-cli` repos, the same files
  everywhere with only an adapter block at the top: P1 CLI redaction, P2 library
  redaction, P4/P19 configuration validation, P5 the transport contract, P6 the retry
  policy, P7 pipes and exit codes (runs the built bin), P8/P9/P13 charset, response
  shapes and error classes, P20 the stderr warning for a plain-`http:` base URL (its
  other-secret case is skipped: the API takes no key), P21 the README's relative links
  (README.md ships to npmjs.com, so a link to a document the `files` allowlist leaves out
  must be an absolute GitHub URL), P23 the log records on stderr and `--log-format`. Mock transports or local servers only, never the live
  API.
- **`package.test.ts`** — the published package: `npm pack --dry-run` must list the library, the bin, `version.js` and the licence documents, and no sources, tests, maps, skills or site.

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 22/24 for every push and PR.
- **release.yml** — on a `v*` tag: verify the tag matches `package.json`, test, `npm pack`, and create a GitHub Release with the tarball. The release notes come from the Conventional-Commit subjects since the previous tag (`.github/scripts/changelog.mjs`); mark a change a script or library caller must adapt to with `type!:` or a `BREAKING CHANGE: <what to do>` footer, and it is also listed under **Behaviour changes** at the top. A change that wasn't marked when committed can still be listed: put a `BREAKING CHANGE:` footer per change into the release commit (the bare `npm version` commit is left out of the type groups, but its footers are read).
- **publish.yml** — manual dispatch from the release tag (`gh workflow run publish.yml --ref vX.Y.Z`; the version is the tag's): publish to npm via OIDC **Trusted Publishing** (no stored `NPM_TOKEN`) with provenance.
- **docs.yml** — build the project website (`site/`, English and German) with the TypeDoc API docs
  under `/api/`, and deploy both to GitHub Pages on each `v*` tag.
  TypeDoc runs from the isolated, lockfile-pinned `tools/docs/` toolchain because it
  needs the TypeScript 6 compiler API, which TypeScript 7 no longer ships; locally,
  run `npm ci --prefix tools/docs` once before `npm run docs`.

## Website

The project website — <https://maschinenlesbar-org.github.io/autobahn-cli/> in English and
<https://maschinenlesbar-org.github.io/autobahn-cli/de/> in German — is built from `site/` with
[Jekyll](https://jekyllrb.com/), [banira](https://sebs.github.io/banira/) web components and
[Fylgja](https://fylgja.dev/) CSS, and deployed by `docs.yml` together with the TypeDoc API
reference under `/api/`. Its content comes from this repository: the README intro and quick
start, the command tree of the built CLI (`site/scripts/cli-reference.mjs`), `Usage.md`,
`GLOSSARY.md` and its German version `GLOSSARY.de.md`, the skills, and the skill examples in
`EXAMPLE.md` and `EXAMPLE.de.md`. The only repo-specific files are `site/_config.yml` and
`site/_data/project.yml` (the German intro and the access requirements); the rest of `site/` is
identical in every maschinenlesbar.org CLI, so change it in all of them together. When the
README intro changes, update the German intro in `site/_data/project.yml`.

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

Every diagnostic line on stderr is a log record (`src/cli/log.ts`): a timestamp, a level
(`ERROR`, `WARN`, `INFO`) and a topic, `autobahn.<area>`. `--log-format text` (the default)
writes it log4j style, `<ISO 8601 UTC> <LEVEL padded to 5> [<topic>] <message>`;
`--log-format jsonl` writes one JSON object per line with exactly `ts`, `level`, `topic`
and `msg`. A record is always one line: `formatLogRecord` runs `escapeForRecord` over
the message (text) or the whole JSON object (jsonl), which writes CR and LF as `\r`/`\n`,
every other C0 control but TAB, DEL and C1 as `\u00XX`, and U+2028, U+2029 and the bidi
controls as `\uXXXX`, so no text that reaches a record, by whatever path, can split it,
forge another one or steer the terminal. Before that a lone surrogate (half a
character, which jq rejects, stopping the whole stream) becomes U+FFFD (`toWellFormed`).
The areas are `cli` (usage errors — commander's and the CLI's own pre-parse
checks — the `(run "… --help" for usage)` pointer after them as `INFO`, other errors and
unexpected ones), `api` (the API's answers: an HTTP error, an unknown road id or
identifier) and `http` (network errors, the cleartext warning). Code logs through
`logOf(deps)` and never writes diagnostics with `io.err` directly. `run()` builds the
logger from argv before commander parses it, and on top of the redacted `io.err`, so a
secret is kept out of the log in either format. commander's own output is buffered and
flushed once the outcome is known (`flush` in `run.ts`): help shown for a bare command
goes to stdout as it is, and on stderr commander's `error: …` becomes an `ERROR` record of
`autobahn.cli` and anything else an `INFO` record. `CliDeps.now` makes the timestamps
testable. stdout carries data only. Only the bin shim's `Output error: …` line
(`handleOutputErrors`, a failed write to stdout) stays a plain line: it is written
straight to `process.stderr`, outside `run()`. Conformance test P23 checks all of this,
and its body is shared across the *-cli repos.
