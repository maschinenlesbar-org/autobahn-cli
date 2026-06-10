---
name: autobahn-ev-planner
description: >
  Plan EV charging stops along German motorways using the autobahn-cli. Trigger
  when the user asks "where can I charge on the A9?", "EV charging stations on
  the A7", "plan charging stops between Munich and Berlin", "fast chargers on my
  route", or wants charging infrastructure along an Autobahn. Lists stations
  across one or more roads, orders them along the corridor, and surfaces power /
  connector / operator detail — not the raw per-road JSON the CLI returns.
version: 1.0.0
userInvocable: true
---

# Autobahn EV Charging Planner

Turn the raw `charging` listings into an **ordered list of charging stops along a route**,
with the power and connector detail a driver actually picks a station on.

## Tooling

This skill drives the `autobahn` command. **Before anything else, validate it is available** — run `command -v autobahn` (or `autobahn --version`). If it is not on your PATH, STOP and inform the user that the `autobahn` CLI (`@maschinenlesbar.org/autobahn-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

Data comes from the `autobahn` CLI (`@maschinenlesbar.org/autobahn-cli`) — read-only, no
key, **one motorway per call**. Pass `--compact`. An empty `[]` (exit `0`) means no chargers on that road — a valid
answer, not an error.

## Step 1 — Resolve the road(s)

Map the request to roadId(s) from `autobahn roads` (`A9`, `A7`, …). A route between two
cities usually spans several motorways — figure out which ones it uses, query each, and
order the combined result end to end (Step 3). "Munich ring" → `A99`.

## Step 2 — List the stations

```bash
autobahn --compact charging list A9
```

Each item is a charging site. The fields that matter:

| Field | Meaning |
|---|---|
| `title` | `A9 \| <rest area / town> \| <site name>` |
| `display_type` | `STRONG_ELECTRIC_CHARGING_STATION` = **fast / HPC**; `ELECTRIC_CHARGING_STATION` = normal. The single best speed signal. |
| `subtitle` | e.g. `Schnellladeeinrichtung` |
| `description[]` | German detail: number of `Ladepunkte`, connector (`DC Kupplung Combo (CCS)`), power (`200+kW`), `Ladesäulenbetreiber:` (operator), features, and `Deutschlandnetz` membership |
| `coordinate` | `{ lat, long }` (strings) — **the reliable position** (see quirk below) |
| `identifier` | Plain numeric id (e.g. `29963`) — **not** base64. Pass to `charging get <id>` for full detail |
| `isBlocked` | `"true"` = out of service |

Parse the `description[]` lines to extract power (kW), connector type, point count, and
operator — they're not separate fields.

> **Quirks.** Use `coordinate.lat` / `coordinate.long`, **not** `point`: for charging the
> `point` string is in `long,lat` order (it varies by service), while `coordinate` always
> has explicit keys. Note `long` (not `lon`). Charging identifiers are plain integers,
> unlike the base64 ids of other services.

## Step 3 — Order along the corridor

Sort the stations so they read in travel order, not API order:

- A station's position is `coordinate.lat` / `coordinate.long`. Sort by the axis the road
  runs along — **latitude** for a roughly N–S motorway (A7, A9), **longitude** for an
  E–W one (A4, A6, A8). Pick the axis with the larger coordinate spread across the
  results; that's the road's main direction.
- If the user gave a start → end, orient the sort that way (north-to-south, etc.) and, if
  you have the endpoints' coords, drop stations outside that stretch.
- Multi-road route: order within each road, then chain the roads in travel order.

## Step 4 — Present the plan

Ordered list, fast chargers called out, with power/connector/operator and a map link:

```
EV charging on the A9 (München → Berlin) — 22 sites, 18 fast (HPC)

 1. ⚡ Sophienberg West (München)      200+kW · CCS · 4 pts · Autostrom plus · Deutschlandnetz
    48.8935, 11.5989  → https://www.google.com/maps?q=49.8935,11.5989
 2. ⚡ Greding Ost                     150kW  · CCS · 6 pts · EnBW
 3. 🔌 Holledau (normal)              ≤50kW  · CCS/Typ2 · 2 pts · …
 …
```

Rules:
- Lead with totals and how many are **fast** (`STRONG_*`) — that's the planning number.
- Show **power, connector, point count, operator** per stop; flag `Deutschlandnetz` sites.
- Mark `isBlocked === "true"` stations as out of service (or omit, but say you did).
- Give a tappable map link from `coordinate` (format `?q=lat,long`).
- If the user wants full detail on one site, offer `autobahn charging get <identifier>`.
- **Optional enrichment:** the Bundesnetzagentur *Ladesäulenregister* (a separate API in
  this project's `apis.md`) carries the same stations with richer tariff/availability
  data — mention it as a follow-up if the user needs live availability, but don't fetch it
  unless asked.
- Don't invent power/connector values the `description` doesn't state; say "not specified".
