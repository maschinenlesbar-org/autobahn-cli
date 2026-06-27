# autobahn-cli

[![CI](https://github.com/maschinenlesbar-org/autobahn-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/maschinenlesbar-org/autobahn-cli/actions/workflows/ci.yml)
[![Release](https://github.com/maschinenlesbar-org/autobahn-cli/actions/workflows/release.yml/badge.svg)](https://github.com/maschinenlesbar-org/autobahn-cli/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@maschinenlesbar.org/autobahn-cli)](https://www.npmjs.com/package/@maschinenlesbar.org/autobahn-cli)

Query live traffic data — roadworks, warnings, closures, parking, webcams and
charging stations — along Germany's motorway network, straight from your
terminal. `autobahn` is a command-line tool over the open
[Autobahn App API](https://autobahn.api.bund.dev/) (`verkehr.autobahn.de`)
operated by Autobahn GmbH des Bundes.

- **Works out of the box** — no account, no API key, no configuration. Install and query.
- **Clean JSON output** — pretty-printed by default, `--compact` for one-line/scripting.
- **Seven commands** — `roads` plus six service groups (`roadworks`, `webcams`, `parking`, `warnings`, `closures`, `charging`), each with `list` and `get`.
- **Nothing to configure** — the API is fully open and read-only; no credentials ever leave your machine.

> Want to use this as a TypeScript library or understand how it's built?
> See **[DEVELOPING.md](DEVELOPING.md)**.

## Install

```bash
npm i -g @maschinenlesbar.org/autobahn-cli
```

This installs the **`autobahn`** command. Requires **Node.js 20+**.

Check it works:

```bash
autobahn --help
```

## Quickstart

No setup needed — the API requires no key. Your first command:

```bash
autobahn roads
```

That returns a JSON array of every motorway the API knows about (`A1`, `A2`, …).
Pull out a flat list with `jq`:

```bash
autobahn roads | jq -r '.[]'
```

Pick a road id and query a service:

```bash
autobahn roadworks list A1
```

## Commands

```text
roads                              list all motorways (A1, A2, ...)
roadworks   list <roadId> | get <identifier>
webcams     list <roadId> | get <identifier>
parking     list <roadId> | get <identifier>   (lorry parking areas)
warnings    list <roadId> | get <identifier>   (traffic warnings)
closures    list <roadId> | get <identifier>
charging    list <roadId> | get <identifier>   (electric charging stations)
```

The `<roadId>` is a motorway designation from `autobahn roads` (e.g. `A1`).
The `<identifier>` for a `get` command is the `identifier` field of an item
returned by the matching `list`.

> On the rare occasion an identifier begins with `-`, it would be read as an
> option; pass it after a `--` separator:
> `autobahn roadworks get -- -odd.identifier`.

### Service commands — subcommand reference

Each of the six service groups (`roadworks`, `webcams`, `parking`, `warnings`,
`closures`, `charging`) supports the same two subcommands:

| Subcommand | Argument | Description |
| --- | --- | --- |
| `list` | `<roadId>` | All items for that service along the motorway |
| `get` | `<identifier>` | Full detail for one item by its base64 identifier |

A `list` that matches no items is **not** an error — it prints `[]` and exits
`0`. A `get` with an unknown or mistyped identifier exits `4`.

## Common tasks

A few recipes to get going — see **[Usage.md](Usage.md)** for the full,
use-case-driven set.

```bash
# Which motorways are covered?
autobahn roads

# Current roadworks on the A1
autobahn roadworks list A1

# Titles of all active roadworks (jq)
autobahn roadworks list A1 | jq -r '.[].title'

# Full detail of one roadwork item (two-step: list → get)
autobahn roadworks list A1 | jq -r '.[0].identifier'
autobahn roadworks get <identifier>

# Webcam URLs along the A99 Munich ring
autobahn webcams list A99 | jq -r '.[].linkurl'

# EV charging stations on the A9 (compact, for scripting)
autobahn --compact charging list A9

# How many active roadworks on the A7?
autobahn roadworks list A7 | jq 'length'
```

## Output & scripting

Every command prints **pretty JSON to stdout**. Errors and diagnostics go to
stderr, so piping stdout into `jq` stays clean.

```bash
# First roadwork title on the A3
autobahn roadworks list A3 | jq -r '.[0].title'

# All warning descriptions on the A2 as a flat list
autobahn warnings list A2 | jq -r '.[].description[]?'
```

Use `--compact` for single-line JSON in pipelines and logs:

```bash
autobahn --compact roadworks list A1
```

`--compact` is a **global** option and works **before or after** the command.

**Exit codes** make the CLI easy to use in scripts:

| Code | Meaning |
| --- | --- |
| `0` | Success (also `--help` / `--version`) |
| `4` | Not found — the API returned `404`, or a `get <identifier>` matched no item |
| `1` | Any other API, network, parse, or usage error |

A `list` returning zero items is not an error — it exits `0` with `[]`.

## Troubleshooting

- **`command not found: autobahn`** — the global npm bin directory isn't on
  your `PATH`. Run `npm bin -g` to find it and add it, or run via
  `npx @maschinenlesbar.org/autobahn-cli …`.
- **Exit `4` / "not found"** from `get` — the identifier doesn't exist or has
  changed. Re-fetch it from a fresh `list` result; identifiers are base64-encoded
  and can change as the live data updates.
- **Empty `[]` from `list`** — there are currently no items of that type on
  that motorway. This is normal and exits `0`.
- **Exit `1` / network error** — connectivity, DNS, or a timeout. Try again, or
  raise the limit with `--timeout 60000`.
- **`3xx` redirect error** — the CLI deliberately does not follow redirects
  (a safety choice for `--base-url`); this means the upstream host moved. Try
  the default base URL: `--base-url https://verkehr.autobahn.de`.

## Global options

These apply to every command and may be given **before or after** it:

| Option | Description |
| --- | --- |
| `-v, --version` | Print the version number |
| `-h, --help` | Show help for the program or a command |
| `--compact` | Print JSON on a single line instead of pretty-printed |
| `--base-url <url>` | API base URL (default `https://verkehr.autobahn.de`) |
| `--timeout <ms>` | Per-request timeout in ms (default `30000`; `0` disables) |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses (default `2`) |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |

## Learn more

- **[Usage.md](Usage.md)** — full use-case-driven cookbook.
- **[GLOSSARY.md](GLOSSARY.md)** — every command, resource, and domain term explained.
- **[DEVELOPING.md](DEVELOPING.md)** — TypeScript library usage, architecture, testing, CI.
- **[SKILLS.md](SKILLS.md)** — Claude Code Agent Skills bundled with this repo (route
  check, EV charging planner, GeoJSON export), installable as a plugin.

## Data license

This CLI is a **client** — it accesses data it does not own or redistribute. The
upstream data is © its provider and licensed **separately from this tool's code**.
See **[DATA_LICENSE.md](DATA_LICENSE.md)**.

> **Die Autobahn GmbH des Bundes** — Datenlizenz Deutschland Namensnennung 2.0
> (`dl-de/by-2-0`, by analogy; not declared on the App API itself). Attribution
> required; commercial use and modification allowed.

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
