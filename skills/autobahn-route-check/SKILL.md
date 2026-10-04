---
name: autobahn-route-check
description: >
  Produce a live disruption briefing for one or more German motorways using the
  autobahn-cli. Trigger when the user asks "is the A3 clear?", "any problems on
  the A1/A7?", "check roadworks and closures before I drive", "what's the traffic
  on the A99?", or wants a trip/commute check across German Autobahnen. Merges
  warnings + closures + roadworks across roads, ranks by severity, drops expired
  noise, and can geo-filter to the stretch between two places.
compatibility: >
  Requires the `autobahn` CLI (npm package @maschinenlesbar.org/autobahn-cli) on
  PATH, installed by the user; the skill never installs it. Uses jq for JSON
  filtering. Network access to verkehr.autobahn.de.
---

# Autobahn Route Check

Give the user a single, ranked briefing of what's wrong on the motorway(s) they care
about — merging real-time **warnings**, **closures**, and **roadworks** across one or
more roads, instead of three separate JSON blobs per road.

## Tooling

This skill drives the `autobahn` command. **Before anything else, validate it is available** — run `command -v autobahn` (or `autobahn --version`). If it is not on your PATH, STOP and inform the user that the `autobahn` CLI (`@maschinenlesbar.org/autobahn-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

This skill also filters JSON with `jq`. **Validate it too** — run `command -v jq`. If it is missing, inform the user that `jq` is not installed — installing it is their responsibility; never install it yourself — and carry on without it: filter the CLI output with `node -e` instead (Node is already on your PATH, since the CLI runs on it).

All data comes from the `autobahn` CLI (the `@maschinenlesbar.org/autobahn-cli` package).
It is read-only, needs no API key, and queries **one motorway at a time**. The whole job
of this skill is the cross-road / cross-service merge the CLI deliberately doesn't do.

Always pass `--compact` so each result is one line, easy to pipe into `jq`. Bump
`--timeout 60000` if a call times out. A `list` that matches nothing prints `[]` and
exits `0` — that is **not** an error, it means "no disruptions of that type", which is
exactly what you want to report. A road id the API does not know exits `4` with
`Unknown road id …` on stderr — never report such a road as clear. Any other non-zero
exit (`1`: `Error: HTTP 502 …`, a timeout, a parse error) means that service **could not
be fetched**: retry that one call once, and if it fails again report the service as
*unavailable* for that road ("A3: warnings unavailable — upstream error"). Never drop it
and never let it count towards a "clear" verdict.

## Step 1 — Resolve the roads

Figure out which roadId(s) the request maps to. Valid ids come from `autobahn roads`
(e.g. `A1`, `A7`, `A99`). Notes:

- Users say "the Munich ring" → `A99`, "the A3" → `A3`. If a name is ambiguous, run
  `autobahn roads` and pick, or ask.
- Multiple roads ("A1, A2 and A7", or a route that uses several) → process each and
  label findings by road.
- Validate against `autobahn roads` before querying. Ids are case-sensitive (`A1`, not
  `a1`); a typo'd or wrong-case id makes every `list` exit `4` with `Unknown road id "a1":
  … (did you mean "A1"?)` — fix the id, don't report the road as clear.

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
| `subtitle` | Direction, e.g. `" Euskirchen -> Dortmund"` — usually with a **leading space**; trim it before matching or splitting on `" -> "` |
| `display_type` | What the item is. On closures: `CLOSURE` (the carriageway) or `CLOSURE_ENTRY_EXIT` (only a junction's on/off ramp — usually most of a road's closures) |
| `isBlocked` | `"true"`/`"false"` string. `"true"` = carriageway blocked **right now**, but the API almost never sets it: in October 2026 it was `"false"` on **all** 306 A1 warnings, closures and roadworks, including `Vollsperrung` closures and 37-minute queues. Take `"true"` as a strong signal and `"false"` as *no information* — judge blocking from `description[]`, `display_type` and `delayTimeValue` (see Step 4). |
| `future` | Boolean — `true` means the item is **planned/upcoming**, not active yet. The primary active-vs-planned signal. |
| `description[]` | Multi-line German detail (start time, cause, length, delay). Often the only place the real time window appears. |
| `delayTimeValue` | Minutes of delay (warnings) — use for severity. A JSON **string** (`"10"`, `"5"`): convert before sorting (`tonumber` in jq, `Number()` in node), or `"5"` ranks above `"37"` |
| `abnormalTrafficType` | `QUEUING_TRAFFIC`, `SLOW_TRAFFIC`, `UNSPECIFIED_ABNORMAL_TRAFFIC` (warnings) — and **absent** on some warnings |
| `startTimestamp` | ISO time on warnings, closures and roadworks (charging uses `DD.MM.YYYY`); warnings are real-time and **auto-expire ~24h**. Offsets differ — warnings `Z` (UTC), roadworks/closures `+02:00` — so compare parsed dates (`fromdateiso8601` needs the `Z` form; use `node -e` + `Date.parse` across services), never the strings |
| `point` | `"lat,long"` of the item |
| `extent` | `"lat,long,lat,long"` bounding box of the affected stretch |
| `routeRecommendation[]` | Official detour advice, if any — always surface it |
| `identifier` | Pass to `autobahn … get <identifier>` for full detail on request |

> **Quirks to respect.** Coordinates use the non-standard key `long` (not `lon`).
> Warnings disappear from the response within ~24h of expiry, so what you fetch *is*
> the current picture — don't cache stale items. A road's listing also carries items of
> **other motorways where they meet** (on the A1: works titled `A45 - Ersatzneubau
> Kreuzungsbauwerk A1-A45 …`, `A255 zur A1, …`) — label such an item with the road its
> title names, or note "at the A1/A45 interchange", rather than as plain A1. The upstream road list carries an id with
> a trailing space next to its trimmed twin (`"A60"` and `"A60 "`); `autobahn roads` trims
> and de-duplicates the list, and `list` trims the id you pass. **Volume is large** — a busy motorway
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
  (or `startTimestamp`). Set these aside — count them, mention notable ones, but don't
  rank them as live disruption. Roadworks and closures state the window in one of **two
  layouts** (each about a quarter to three quarters of a road's items):
  - `Zeitraum dieser Bauphase:` then `Beginn: DD.MM.YY um HH:MM Uhr` and
    `Ende: DD.MM.YY um HH:MM Uhr`;
  - `Die Baustelle ist zu folgenden Zeiträumen gültig:` then one or more lines
    `DD.MM.YY HH:MM bis zum DD.MM.YY HH:MM Uhr.` (night closures often list several).
  Warnings carry only a `Beginn:` line. Times are German local time.
- **Active** otherwise.

Classify by **`display_type`, not by the command** that returned an item: `warnings list`
also carries real-time closures (`display_type: "CLOSURE"`, e.g. an `INRIX--vi-zus.…`
identifier) that `closures list` does not have. Rank those with the closures and count
them there.

Then rank the **active** items, most severe first:

1. **Closures** that are genuinely shutting the road — `display_type === "CLOSURE"` with
   `isBlocked === "true"` **or** a `description[]` that says full closure (`Vollsperrung`) /
   no through traffic. A plain active `CLOSURE` entry without those is partial/lane-level —
   treat as mid severity.
   **Ramp closures** (`display_type === "CLOSURE_ENTRY_EXIT"`) close a junction's on- or
   off-ramp, not the motorway — 48 of the 54 A1 closures in October 2026. Count them
   separately, list one only when it is at a junction the user named, and never let them
   make the road read as shut.
2. **Warnings** by `delayTimeValue` as a number (higher = worse; it arrives as a string —
   `sort_by(.delayTimeValue | tonumber? // 0) | reverse`). At equal delay:
   `QUEUING_TRAFFIC` > `SLOW_TRAFFIC` > `UNSPECIFIED_ABNORMAL_TRAFFIC` > no
   `abnormalTrafficType` at all (show such a warning by its `description[]`).
3. **Roadworks** — background unless they're blocking (`isBlocked === "true"`, or a
   `description[]` that says `Vollsperrung` / the carriageway is closed); those few rank
   with closures.

Drop obvious duplicates (a closure and a warning describing the same spot — match on
near-identical `extent`/`point` and direction). Exclude anything already past its window.

## Step 5 — Brief the user

**Summarise counts, enumerate only what a driver acts on.** Per road, lead with a verdict
line carrying the totals, then list **only** the active blocking closures, blocking
roadworks, and the worst few warnings. Roadworks and planned/non-blocking closures are a
count, never a list — 200+ roadworks is normal and dumping them is useless.

```
A1 — ⚠ drivable: no full blockages, a few short jams
     (6 closures + 41 ramp closures / 256 roadworks listed — none currently blocking)
  🐢 +11 min  QUEUING  A1 Osnabrück → Bremen, Krummhörens Kuhlen–Bremen-Hemelingen
  🐢 +7 min   SLOW     A1 Euskirchen → Dortmund, Köln-Nord–Leverkusener Brücke

A3 — 🚧 1 full closure tonight (planned), otherwise drivable
  🚧 CLOSED   A3 Köln-Ost → Frankfurt: Vollsperrung, planned from 22:00 (future)
              Detour: U41.
  🐢 +11 min  QUEUING  A3 Köln → Arnheim, Oberhausen-Lirich–Oberhausen

A7 — ✓ clear (no active closures or warnings; 1 background roadwork)
```

Rules:
- **Ramps are not the road.** Report ramp closures as a count ("41 ramp closures"), apart
  from the carriageway closures.
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
