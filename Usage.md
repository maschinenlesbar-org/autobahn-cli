# autobahn-cli — Usage

Use-case-driven examples for the `autobahn` CLI, a client for the open
[Autobahn App API](https://autobahn.api.bund.dev/) (`verkehr.autobahn.de`):
live roadworks, traffic warnings, closures, lorry parking, webcams and electric
charging stations along the German motorway network. The CLI is read-only and
needs no API key. Every command prints pretty JSON to stdout.

## Install

```bash
npm i -g @maschinenlesbar.org/autobahn-cli
```

This installs the `autobahn` bin. To run without a global install, use
`node dist/src/cli/index.js` (after `npm run build`) in place of `autobahn` in
any example below.

## Use cases

### 1. Discover which motorways are covered

Find the valid `<roadId>` values (e.g. `A1`, `A8`, `A99`) you can pass to every
other command.

```bash
autobahn roads
```

Returns a JSON array of motorway ids. Pipe through `jq` to get a flat,
greppable list:

```bash
autobahn roads | jq -r '.[]'
```

### 2. See current roadworks on the A1

Check what construction sites are active before a trip down the A1.

```bash
autobahn roadworks list A1
```

Each item includes an `identifier` (base64) you can feed to `roadworks get`.
Pull just the human-readable titles:

```bash
autobahn roadworks list A1 | jq -r '.[].title'
```

### 3. List open closures on a motorway

Closures are full or partial blockings — useful for spotting a route that is
shut entirely.

```bash
autobahn closures list A3
```

A `list` that matches nothing is **not** an error: it prints an empty result
and exits `0`.

### 4. Read the full detail of one item by its identifier

The `list` output is a summary; `get` fetches the complete record for a single
item, addressed by the `identifier` field from a matching `list`.

```bash
# 1) grab an identifier from the list
autobahn roadworks list A1 | jq -r '.[0].identifier'

# 2) fetch its full detail (paste the identifier from step 1)
autobahn roadworks get <identifier>
```

`get` with an unknown id (or a 404 from the API) exits `4` (not found).

### 5. Find webcams along the A99 (Munich ring)

Pull live camera locations so you can eyeball traffic conditions.

```bash
autobahn webcams list A99
```

Extract the linkable camera URLs with `jq`:

```bash
autobahn webcams list A99 | jq -r '.[].linkurl'
```

### 6. Locate lorry parking areas on the A8

Plan a rest stop by listing the parking areas (and their occupancy data) along
a route.

```bash
autobahn parking list A8
```

### 7. Find EV charging stations along a road

List electric charging stations on the A9 to plan where to recharge.

```bash
autobahn charging list A9
```

Then drill into one station's details:

```bash
autobahn charging get <identifier>
```

### 8. Check traffic warnings, compactly, for scripting

`--compact` prints single-line JSON — handy when piping into another tool or
logging. Note it is a **global** option and goes *before* the command.

```bash
autobahn --compact warnings list A2
```

### 9. Count how many roadworks are active on a motorway

Combine `list` with `jq` for a quick metric.

```bash
autobahn roadworks list A7 | jq 'length'
```

### 10. Run against a different host or with a longer timeout

Point the client at an alternate base URL, or relax the per-request timeout for
slow networks. These are global options, placed before the command.

```bash
autobahn --timeout 60000 --user-agent "trip-planner/1.0" warnings list A1
autobahn --base-url https://verkehr.autobahn.de roads
```

## Global options

All global options go **before** the command (e.g. `autobahn --compact roads`).

| Option | Description |
| --- | --- |
| `-v, --version` | Print the version number |
| `--base-url <url>` | API base URL (default `https://verkehr.autobahn.de`) |
| `--timeout <ms>` | Per-request timeout in milliseconds (`0` disables) |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |
| `--compact` | Print JSON on a single line instead of pretty-printed |
| `-h, --help` | Display help for a command |

Commands: `roads`, and the six service groups `roadworks`, `webcams`,
`parking`, `warnings`, `closures`, `charging` — each with `list <roadId>` and
`get <identifier>` subcommands.

Exit codes: `0` success, `4` not found (`get` matched nothing / API `404`),
`1` any other API, network, parse, or usage error.
