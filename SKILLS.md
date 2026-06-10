# autobahn-cli — Claude Code Skills

A set of [Claude Code](https://code.claude.com/docs/en/skills) **Agent Skills** for live
German motorway intelligence, all powered by the **[autobahn](README.md)** CLI over the
open [Autobahn App API](https://autobahn.api.bund.dev/) (`verkehr.autobahn.de`).

Each skill teaches Claude how to drive the `autobahn` CLI to answer a specific, real-world
question — "is my route clear?", "where can I charge an EV on the A9?", "give me the
roadworks as GeoJSON" — and to report the answer with evidence rather than guesswork. They
encode the parts that are easy to get wrong (planned-vs-active closures, the inconsistent
coordinate ordering across services) so Claude doesn't have to rediscover them each time.

## Skills

| Skill | What it does | Ask it… |
|---|---|---|
| **autobahn-route-check** | Merges warnings + closures + roadworks across one or more roads, separates active from planned, and ranks by severity. | "is the A3 clear?", "any problems on the A1 and A7 before I drive?" |
| **autobahn-ev-planner** | Lists EV charging stations along a route, orders them along the corridor, and surfaces power / connector / operator detail. | "where can I charge on the A9?", "plan charging stops Munich → Berlin" |
| **autobahn-map** | Exports any service (roadworks, closures, parking, charging…) as a valid GeoJSON `FeatureCollection` for Leaflet / geojson.io / QGIS. | "map the roadworks on the A99", "export A1 closures as GeoJSON" |

## Requirements

- **[Claude Code](https://code.claude.com/docs/en/overview)** (or any harness that loads
  Agent Skills).
- **The `autobahn` CLI** installed globally:
  ```bash
  npm i -g @maschinenlesbar.org/autobahn-cli   # installs the `autobahn` bin
  ```
  No API key is required — the Autobahn App API is free, open, and read-only.

## Installation

### Plugin marketplace (recommended)

This repo is a Claude Code **plugin marketplace**, so installation is two commands inside
Claude Code:

```
/plugin marketplace add maschinenlesbar-org/autobahn-cli
/plugin install autobahn@autobahn-skills
```

The first command registers the marketplace; the second installs the `autobahn` plugin,
which bundles all three skills. Update later with `/plugin marketplace update`.

### Manual (copy the skill folders)

Prefer not to use the marketplace? Copy the skills into your **personal** directory
(available across all your projects):

```bash
git clone https://github.com/maschinenlesbar-org/autobahn-cli tmp-skills
mkdir -p ~/.claude/skills
cp -R tmp-skills/skills/* ~/.claude/skills/
rm -rf tmp-skills
```

…or into a single project's `.claude/skills/` by swapping `~/.claude/skills` for
`.claude/skills`. Each skill lives in its own directory with a `SKILL.md`, e.g.
`skills/autobahn-route-check/SKILL.md`. Start a new Claude Code session and the skills are
picked up automatically.

## Usage

You don't normally invoke these by name — Claude auto-selects the right skill from your
request. Just ask in natural language:

> Check the A1 and A3 for disruptions before a drive.

> Where can I charge an EV on the A9, fastest chargers first?

> Export all roadworks on the A99 as GeoJSON so I can open it in geojson.io.

You can also invoke a skill explicitly with its slash command, e.g. `/autobahn-route-check`.

## How it works

Every skill is a single `SKILL.md` — a short, model-facing playbook describing which
`autobahn` subcommands to call, in what order, and how to interpret the JSON. The skills
encode the non-obvious parts of this API, for example:

- closures' `isBlocked` reads `"false"` even on roads that are shut — the reliable
  active-vs-planned signal is the `future` flag plus the German `Beginn:` window in
  `description[]` (see **autobahn-route-check**);
- a busy motorway returns 40–60 closures and 200+ roadworks, most planned or
  non-blocking — summarise counts, enumerate only what a driver acts on;
- the `point` string's coordinate order is **inconsistent across services** (`lat,long`
  for roadworks/warnings, `long,lat` for parking/charging) — always read the explicit
  `coordinate` object instead, and note its key is `long`, not the RFC-7946 `lon`
  (see **autobahn-map**);
- charging identifiers are plain integers, unlike the base64 ids of other services.

## Contributing

This project does not accept external code contributions (see
[CONTRIBUTING.md](CONTRIBUTING.md)). When adding a skill internally, keep `SKILL.md`
focused, give it a `description` with concrete trigger phrases, and follow the
[official skill format](https://code.claude.com/docs/en/skills).

## License

[AGPL-3.0-or-later](LICENSE) © Sebastian Schürmann. See [LICENSING.md](LICENSING.md) for
the dual-licensing / commercial option.
