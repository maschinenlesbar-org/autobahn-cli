---
name: autobahn-route-check
description: >
  Produce a live disruption briefing for one or more German motorways using the
  autobahn-cli. Trigger when the user asks "is the A3 clear?", "any problems on
  the A1/A7?", "check roadworks and closures before I drive", "what's the traffic
  on the A99?", or wants a trip/commute check across German Autobahnen. Merges
  warnings + closures + roadworks across roads, ranks by severity, drops expired
  noise, and can geo-filter to the stretch between two places.
version: 1.0.0
userInvocable: true
---

# Autobahn Route Check

Give the user a single, ranked briefing of what's wrong on the motorway(s) they care
about — merging real-time **warnings**, **closures**, and **roadworks** across one or
more roads, instead of three separate JSON blobs per road.

## Tooling

This skill drives the `autobahn` command. **Before anything else, validate it is available** — run `command -v autobahn` (or `autobahn --version`). If it is not on your PATH, STOP and inform the user that the `autobahn` CLI (`@maschinenlesbar.org/autobahn-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

All data comes from the `autobahn` CLI (the `@maschinenlesbar.org/autobahn-cli` package).
It is read-only, needs no API key, and queries **one motorway at a time**. The whole job
of this skill is the cross-road / cross-service merge the CLI deliberately doesn't do.

Always pass `--compact` so each result is one line, easy to pipe into `jq`. Bump
`--timeout 60000` if a call times out. A `list` that matches nothing prints `[]` and
exits `0` — that is **not** an error, it means "no disruptions of that type", which is
exactly what you want to report.

## Step 1 — Resolve the roads

Figure out which roadId(s) the request maps to. Valid ids come from `autobahn roads`
(e.g. `A1`, `A7`, `A99`). Notes:

- Users say "the Munich ring" → `A99`, "the A3" → `A3`. If a name is ambiguous, run
  `autobahn roads` and pick, or ask.
- Multiple roads ("A1, A2 and A7", or a route that uses several) → process each and
  label findings by road.
- Validate against `autobahn roads` before querying; a typo'd road id wastes three calls
  that all 404.

## Step 2 — Pull the three disruption services per road

For each roadId, fetch all three. They are independent — fan them out:

```bash
autobahn --compact warnings  list A1
autobahn --compact closures  list A1
autobahn --compact roadworks list A1
```

Each returns an array of items. The fields that matter for a briefing:

| Field | Meaning |
|---|---|
| `title` | Human label, usually `A1 \| <from> - <to>` |
| `subtitle` | Direction, e.g. `Euskirchen -> Dortmund` |
| `isBlocked` | `"true"`/`"false"` string. `"true"` = carriageway blocked **right now**. **Unreliable on closures** — most listed closures carry `"false"` even when shut (see Step 4). Trust it on warnings/roadworks; corroborate it on closures. |
| `future` | Boolean — `true` means the item is **planned/upcoming**, not active yet. The primary active-vs-planned signal. |
| `description[]` | Multi-line German detail (start time, cause, length, delay). Often the only place the real time window appears. |
| `delayTimeValue` | Minutes of delay (warnings) — use for severity |
| `abnormalTrafficType` | e.g. `SLOW_TRAFFIC`, `QUEUING_TRAFFIC` (warnings) |
| `startTimestamp` | ISO time; warnings are real-time and **auto-expire ~24h** |
| `point` | `"lat,long"` of the item |
| `extent` | `"lat,long,lat,long"` bounding box of the affected stretch |
| `routeRecommendation[]` | Official detour advice, if any — always surface it |
| `identifier` | Pass to `autobahn … get <identifier>` for full detail on request |

> **Quirks to respect.** Coordinates use the non-standard key `long` (not `lon`).
> Warnings disappear from the response within ~24h of expiry, so what you fetch *is*
> the current picture — don't cache stale items. Some road ids come back with a trailing
> space upstream; the CLI already trims them. **Volume is large** — a busy motorway
> routinely returns 40–60 closures and 200+ roadworks, the vast majority planned or
> non-blocking. Never enumerate all of them (see Step 5); summarise and surface only what
> a driver acts on.

## Step 3 — (Optional) geo-filter to a stretch

If the user named a start and end ("between Köln and Leverkusen", "the southern part of
the A8"), don't report the whole motorway. Build a rough bounding box from the two
places' lat/long and keep only items whose `point` (or `extent`) falls inside it. If you
don't have coordinates for the place names and can't get them cheaply, say you're
reporting the **whole road** rather than silently guessing a segment.

## Step 4 — Classify, then rank

First split every item into **active** vs **planned**, because the briefing leads with what's
happening now. Do **not** use `isBlocked` alone for closures — it reads `"false"` on most
closures even when the road is shut. Classify like this:

- **Planned** if `future === true`, or the `description[]` time window starts in the future
  (parse the German `Beginn: DD.MM.YY um HH:MM Uhr` line / `startTimestamp`). Set these
  aside — count them, mention notable ones, but don't rank them as live disruption.
- **Active** otherwise.

Then rank the **active** items, most severe first:

1. **Closures** that are genuinely shutting the road — `isBlocked === "true"` **or** a
   `description[]` that says full closure (`Vollsperrung`) / no through traffic. A plain
   active closure entry without those is partial/lane-level — treat as mid severity.
2. **Warnings** by `delayTimeValue` (higher = worse); `QUEUING_TRAFFIC` outranks
   `SLOW_TRAFFIC` at equal delay.
3. **Roadworks** — background unless they're blocking (`isBlocked === "true"`); those few
   rank with closures.

Drop obvious duplicates (a closure and a warning describing the same spot — match on
near-identical `extent`/`point` and direction). Exclude anything already past its window.

## Step 5 — Brief the user

**Summarise counts, enumerate only what a driver acts on.** Per road, lead with a verdict
line carrying the totals, then list **only** the active blocking closures, blocking
roadworks, and the worst few warnings. Roadworks and planned/non-blocking closures are a
count, never a list — 200+ roadworks is normal and dumping them is useless.

```
A1 — ⚠ drivable: no full blockages, a few short jams
     (47 closures / 256 roadworks listed — none currently blocking)
  🐢 +11 min  QUEUING  A1 Osnabrück → Bremen, Krummhörens Kuhlen–Bremen-Hemelingen
  🐢 +7 min   SLOW     A1 Euskirchen → Dortmund, Köln-Nord–Leverkusener Brücke

A3 — 🚧 1 full closure tonight (planned), otherwise drivable
  🚧 CLOSED   A3 Köln-Ost → Frankfurt: Vollsperrung, planned from 22:00 (future)
              Detour: U41.
  🐢 +11 min  QUEUING  A3 Köln → Arnheim, Oberhausen-Lirich–Oberhausen

A7 — ✓ clear (no active closures or warnings; 1 background roadwork)
```

Rules:
- **Cap enumeration.** List every active *blocking* closure/roadwork, and at most the top
  ~3–5 warnings by delay. Everything else is a number in the verdict line.
- **Separate planned from active.** Tag upcoming items `(planned)` / with their start time;
  never let a future closure read as a road that's shut now.
- If a road has nothing active, say so plainly — "A7: clear" is a valid, useful answer.
- Surface `routeRecommendation` / detour info whenever present.
- Show delay minutes and direction (`subtitle`) — those are what a driver acts on.
- Offer the `get <identifier>` follow-up for any item the user wants full detail on, but
  don't dump raw JSON unless asked.
- Don't invent severity the data doesn't support; if `isBlocked` is false and there's no
  delay value, it's informational.
