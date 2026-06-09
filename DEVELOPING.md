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
import { AutobahnClient, AutobahnApiError } from "@maschinenlesbar.org/autobahn-cli";

const client = new AutobahnClient(); // defaults to https://verkehr.autobahn.de

const roads = await client.roads();              // ["A1", "A2", ...]
const works = await client.roadworks.list("A1"); // AutobahnServiceItem[]
const detail = await client.warnings.get(works[0]!.identifier!);

try {
  await client.closures.get("DOES-NOT-EXIST");
} catch (err) {
  if (err instanceof AutobahnApiError) console.error(err.status, err.detail);
}
```

### Client options

```ts
new AutobahnClient({
  baseUrl: "https://verkehr.autobahn.de",
  timeoutMs: 15_000,
  maxRetries: 3,              // 429 / 503 are retried (honours Retry-After, else linear backoff)
  maxResponseBytes: 50 << 20, // abort responses larger than 50 MiB (0 = unlimited)
  userAgent: "my-app/1.0",
  transport: customTransport, // inject your own HTTP transport
});
```

### Resource groups

`client.roadworks`, `.webcams`, `.parkingLorries`, `.warnings`, `.closures`,
`.chargingStations` — each with `.list(roadId)` and `.get(identifier)`. Plus
`client.roads()` for the motorway list.

## Authentication internals

The Autobahn App API requires **no authentication and no API key**. Every
endpoint under `/o/autobahn` is fully open and read-only. The client attaches
no credential headers. `--base-url` is trusted input: the CLI fetches whatever
host you point it at; only `http:`/`https:` URLs are accepted, and redirects
are **not** followed — a `3xx` surfaces as an error rather than being chased to
another host.

## Architecture

```
src/
  client/
    types.ts     # response interfaces (typed list items; details as JsonObject)
    query.ts     # dependency-free query-string builder
    http.ts      # the Transport interface + default node:http/https transport
    engine.ts    # URL building, retry/backoff, JSON/raw decoding, error mapping
    errors.ts    # AutobahnError / AutobahnApiError / AutobahnNetworkError / AutobahnParseError
    client.ts    # AutobahnClient — a generic ServiceResource per service group
  cli/
    io.ts        # injectable I/O seam (stdout/stderr)
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
serialises queries, applies retry/backoff, decodes JSON responses and maps
errors. Sits between the client's resource methods and the transport.

**RawResponse.** The low-level result of a request: `{ data: Buffer,
contentType, status }` — raw bytes plus metadata, before JSON decoding.

**Query-string builder.** [`query.ts`](src/client/query.ts) — a dependency-free
serialiser: omits `undefined`/`null`, repeats keys for arrays (`?id=a&id=b`),
renders booleans as `"true"`/`"false"`, dates as ISO-8601, and encodes spaces as
`%20`.

**CliDeps / CliIO.** The dependency-injection seam for the CLI
([`io.ts`](src/cli/io.ts)): a client factory plus an I/O object (`out`/`err`).
Lets the whole CLI run in tests with a mocked client and captured output — no
subprocess.

**Error types.** [`errors.ts`](src/client/errors.ts): `AutobahnApiError`
(non-2xx, carries `status`/`detail`/`url`/`body`), `AutobahnNetworkError`
(transport failure/timeout), `AutobahnParseError` (bad JSON), all extending
`AutobahnError`.

**Retry / backoff.** Transient `429` (rate-limited) and `503` (service
unavailable) are retried automatically with backoff, up to `maxRetries`
(default `2`), honouring a `Retry-After` header when present (both
delta-seconds and HTTP-date forms), otherwise using linear backoff.
`AutobahnApiError.isRetryable` reflects this.

**`maxResponseBytes`.** A hard cap on response body size (default 100 MiB;
`0` disables) that defends against memory exhaustion from a hostile or buggy
endpoint.

**Empty-body 404.** The detail endpoint answers an unknown identifier with
HTTP 200 and an empty body rather than a true `404`. The engine treats an
empty (or whitespace-only) body as not-found and raises a synthetic
`AutobahnApiError` with status `404` (CLI exit `4`), instead of a misleading
parse error.

## Testing

```bash
npm test          # builds, then runs `node --test` over dist/test
```

- **`query.test.ts`** — query-string serialisation.
- **`http.test.ts`** — the default transport against a real loopback `http.createServer`.
- **`engine.test.ts`** — URL building, JSON decoding, error mapping, 429/503 retry — mocked transport.
- **`client.test.ts`** — every resource's method/URL mapping — mocked transport.
- **`shared.test.ts`** — option parsing (`parseIntArg`) and `toEngineOptions` mapping.
- **`cli.test.ts`** — end-to-end command parsing, rendering, error/exit codes and option flow-through — mocked client.

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 20/22/24 for every push and PR.
- **release.yml** — on a `v*` tag: verify the tag matches `package.json`, test, `npm pack`, and create a GitHub Release with the tarball.
- **publish.yml** — manual dispatch: publish to npm via OIDC **Trusted Publishing** (no stored `NPM_TOKEN`) with provenance.
- **docs.yml** — build TypeDoc API docs and deploy to GitHub Pages on each `v*` tag.

## License

Dual-licensed under **[AGPL-3.0-or-later](LICENSE)** or a commercial license — see
**[LICENSING.md](LICENSING.md)**. This project does **not** accept external code
contributions; see **[CONTRIBUTING.md](CONTRIBUTING.md)**.
