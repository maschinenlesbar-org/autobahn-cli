# autobahn-cli

A TypeScript **API client** and **command-line interface** for the open
[Autobahn App API](https://autobahn.api.bund.dev/) (`verkehr.autobahn.de`) operated by
Autobahn GmbH — live **roadworks**, **traffic warnings**, **closures**, **lorry parking**,
**webcams** and **electric charging stations** along the German motorway network.

- **Zero runtime HTTP dependencies** — built on Node's built-in `http`/`https` (no axios, no fetch polyfill).
- **One small dependency** for the CLI: [`commander`](https://github.com/tj/commander.js).
- **Strongly typed** — typed client surface and response shapes.
- **Well tested** — unit tests on Node's built-in test runner (`node --test`), every HTTP response mocked.
- **Read-only, no auth** — the Autobahn API needs no key; this client only reads.

New to the Autobahn API, or terms like *roadId*, the base64 *identifier*, or the
six service resources (roadworks, webcams, parking, warnings, closures,
charging)? See **[GLOSSARY.md](GLOSSARY.md)** for the domain concepts and the
project's own vocabulary.

## Requirements

- Node.js **>= 20** (uses the stable built-in test runner, ESM and top-level `await`).

## Install

```bash
npm install
npm run build        # compiles TypeScript to dist/
```

Run the CLI without a global install:

```bash
node dist/src/cli/index.js --help
# or, after `npm link` / global install:
autobahn --help
```

---

## CLI usage

Every command prints pretty JSON to stdout (`--compact` for a single line).

### Global options

| Option | Description |
| --- | --- |
| `--base-url <url>` | API base URL (default `https://verkehr.autobahn.de`) |
| `--timeout <ms>` | Per-request timeout in ms (default `30000`; `0` disables the timeout) |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses (default `2`) |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |
| `--compact` | Print JSON on a single line |

Global options go **before** the command, e.g. `autobahn --compact roads`.

### Commands

```text
roads                              list all motorways (A1, A2, ...)
roadworks   list <roadId> | get <id>
webcams     list <roadId> | get <id>
parking     list <roadId> | get <id>     (lorry parking areas)
warnings    list <roadId> | get <id>     (traffic warnings)
closures    list <roadId> | get <id>
charging    list <roadId> | get <id>     (electric charging stations)
```

The `<roadId>` is a motorway id from `autobahn roads` (e.g. `A1`). The `<id>` for a
`get` command is the `identifier` field of an item returned by the matching `list`.

### Examples

```bash
# Which motorways are covered?
autobahn roads

# Roadworks on the A1, compact
autobahn --compact roadworks list A1

# A specific charging station's details (identifier from `charging list`)
autobahn charging list A8
autobahn charging get <identifier>

# Webcams along the A99
autobahn webcams list A99
```

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Success (also `--help` / `--version`) |
| `4` | Not found — the API returned `404`, or a `get <id>` matched no item (the detail endpoint answers an unknown id with an empty body, which is mapped to a not-found error) |
| `1` | Any other API, network, or parse error |
| `1` | Usage error (unknown command, invalid option value) |

A `list <roadId>` that matches no items is **not** an error: it prints an empty
array `[]` and exits `0`. Only a `get <id>` with no matching item (or a `404`
from the API) is treated as not-found (exit `4`).

`--base-url` is trusted input: the CLI fetches whatever host you point it at and
prints the JSON. No credentials are ever attached, and only `http:`/`https:` URLs
are accepted. Redirects are **not** followed — a `3xx` from the API surfaces as an
error rather than being chased to another host.

---

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

---

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

---

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

**Dual-licensed** — use it under **either**:

- **[AGPL-3.0-or-later](LICENSE)** (default, free). Note the AGPL's §13 network
  clause: if you run a modified version as a network service, you must offer that
  modified source to the service's users.
- **Commercial license** (paid), for closed-source / proprietary or SaaS use
  without the AGPL's obligations.

See **[LICENSING.md](LICENSING.md)** for details, and **[CONTRIBUTING.md](CONTRIBUTING.md)**
for the contribution policy (this project does not accept external code
contributions). Commercial enquiries: **sebs@2xs.org**.
