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
| `title` | `A7 \| <direction or junction> \| <site name>`. The middle part is usually the next destination in the **direction of travel**, i.e. it tells which carriageway the site serves (`A7 \| Hannover \| Brunautal West` vs `A7 \| Hamburg \| Brunautal Ost`; Deutschlandnetz sites name the motorway's end points, e.g. `Reutte` / `Appenrade` on the A7). A junction (`AS Bispingen`, `AK Kassel-Mitte`) marks a site just off the motorway. Some titles have only two parts (`A7 \| Brokenlande Ost`). |
| `display_type` | `STRONG_ELECTRIC_CHARGING_STATION` or `ELECTRIC_CHARGING_STATION`. **Not a speed signal**: nearly every site carries `STRONG_*`, including sites whose best point is 43–50 kW. Judge speed from the kW lines in `description[]`. |
| `subtitle` | `Schnellladeeinrichtung` / `Normalladeeinrichtung` (mirrors `display_type`) |
| `description[]` | German detail in one of **two layouts** (see below) |
| `coordinate` | `{ lat, long }`, **strings** here — `Number()` them (see quirk below) |
| `identifier` | Deutschlandnetz sites have a plain numeric id (`30388`); all other sites a base64 id (`RUxFQ1RSSUNfQ0hBUkdJTkdfU1RBVElPTl9fMTkyMzE=`, which decodes to `ELECTRIC_CHARGING_STATION__19231`). `charging get <id>` accepts both. |
| `isBlocked` | `"true"` = out of service |

Power, connector, point count and operator are not separate fields — parse them from
`description[]`, which comes in two layouts:

- **Deutschlandnetz sites** (numeric `identifier`): the title, a point count
  (`4 Ladepunkte`), one connector line (`DC Kupplung Combo (CCS)`), one power line
  (`200+kW`), `Ladesäulenbetreiber: <operator>`, an `Ausstattungsmerkmale:` list, and
  `Dieser Standort ist Teil des Deutschlandnetzes.`
- **All other sites** (base64 `identifier`, the large majority): the site name, postcode
  and town, then one block per point — `Ladepunkt 1:`, its connectors
  (`DC Kupplung Combo, DC CHAdeMO` or `AC Kupplung Typ 2`) and its power (`50 kW`).
  Count the `Ladepunkt N:` blocks for the point count and take the highest kW as the
  site's best speed. **There is no operator line** — say "operator not stated".

> **Quirks.** Use `coordinate.lat` / `coordinate.long`, **not** `point`: for charging the
> `point` string is in `long,lat` order (it varies by service), while `coordinate` has
> explicit keys. Note `long` (not `lon`).

## Step 3 — Order along the corridor

Sort the stations so they read in travel order, not API order:

- A station's position is `coordinate.lat` / `coordinate.long`. Sort by the axis the road
  runs along — **latitude** for a roughly N–S motorway (A7, A9), **longitude** for an
  E–W one (A4, A6, A8). Pick the axis with the larger coordinate spread across the
  results; that's the road's main direction.
- If the user gave a start → end, orient the sort that way (north-to-south, etc.) and, if
  you have the endpoints' coords, drop stations outside that stretch.
- **Pick the carriageway.** Most service-area sites serve one direction only. The `title`
  middle part names the next destination *ahead of that site* — on the A9,
  `A9 | Nürnberg | Köschinger Forst Ost` is northbound and
  `A9 | München | Köschinger Forst West` southbound — and the site-name suffix
  (`Ost`/`West`, `O`/`W`, `Nord`/`Süd`) usually tells a pair apart. For a one-way trip keep
  your side and list the opposite side separately, or say you did not split by side.
- Multi-road route: order within each road, then chain the roads in travel order.

## Step 4 — Present the plan

Ordered list, fast chargers called out, with power/connector/operator and a map link
(sample output from 2026-09-15 data):

```
EV charging on the A9, München → Berlin (northbound side) — 22 sites on the road,
9 on your side, 2 with ≥150 kW

 1. ⚡ Köschinger Forst Ost (3)          4× 350 kW · CCS · operator not stated
       48.8366, 11.4722  → https://www.google.com/maps?q=48.8366,11.4722
 2. 🔌 Nürnberg-Feucht Ost              50 kW CCS/CHAdeMO + 43 kW Typ 2 · operator not stated
 3. ⚡ Sophienberg O                     4 pts · 200+kW · CCS · Autostrom plus GmbH · Deutschlandnetz
       49.8942, 11.6008  → https://www.google.com/maps?q=49.8942,11.6008
 …
Southbound side (… West / W sites): 13 more for the way back.
```

Rules:
- Lead with totals and how many are **fast** — count sites by their best kW line (e.g.
  ≥150 kW), not by `STRONG_*`, which nearly every site carries.
- Show **power, connector, point count, operator** per stop; flag `Deutschlandnetz` sites.
- Mark `isBlocked === "true"` stations as out of service (or omit, but say you did).
- Give a tappable map link from `coordinate` (format `?q=lat,long`).
- If the user wants full detail on one site, offer `autobahn charging get <identifier>`.
- **Optional enrichment:** the Bundesnetzagentur *Ladesäulenregister* (a separate API in
  this project's `apis.md`) carries the same stations with richer tariff/availability
  data — mention it as a follow-up if the user needs live availability, but don't fetch it
  unless asked.
- Don't invent power/connector values the `description` doesn't state; say "not specified".
