# Glossary

A reference for the domain concepts and project-specific terms used throughout
`autobahn-cli`. The API is the **open Autobahn App API** (`verkehr.autobahn.de`),
operated by **Autobahn GmbH des Bundes**, which carries the live data behind the
official Autobahn app. The domain is German motorways; this glossary gives the
English term used in the CLI/client alongside the original German where one
applies.

---

## The API & operator

**Autobahn App API.** The open, read-only REST API at `verkehr.autobahn.de`
(documented community-side at `autobahn.api.bund.dev`). It exposes live traffic
data along the German federal motorway network. All endpoints this tool uses live
under the `/o/autobahn` API root and require **no authentication and no API key**.

**Autobahn GmbH (des Bundes).** The federally owned company that operates and
maintains Germany's *Bundesautobahnen* (federal motorways) and publishes this API.

**API root (`/o/autobahn`).** The common path prefix under the base URL for every
endpoint: the motorway list (`/o/autobahn/`), the per-motorway service listings
(`/o/autobahn/{roadId}/services/{service}`) and the detail endpoints
(`/o/autobahn/details/{service}/{identifier}`).

---

## Core resources

**Autobahn / motorway (`roadId`).** A German federal motorway, identified by its
designation such as `A1`, `A2`, `A99`. `GET /o/autobahn/` returns the full list
of motorways the API knows about (the `roads` array). CLI: `roads`. The `roadId`
is the required path segment for every service `list` command.

**Roadworks (`roadworks`).** Active or planned construction/maintenance works
along a motorway (German *Baustellen*). CLI: `roadworks`.

**Webcam (`webcam`).** A traffic camera along a motorway; items carry an
`imageurl` (the snapshot) and a `linkurl`. CLI: `webcams`. The upstream service
currently lists **no webcams on any road checked** (A1, A3, A7, A8, A99 in
September 2026): `webcams list` prints `[]` — an upstream data gap, not an error.

**Parking lorry / lorry parking (`parking_lorry`).** Truck/HGV parking areas
along a motorway (German *Lkw-Parkplätze / Rastplätze*) and their occupancy
information. CLI: `parking`.

**Warning (`warning`).** A traffic warning along a motorway (German
*Verkehrsmeldung* / *Verkehrswarnung*) — e.g. congestion, accidents, hazards.
CLI: `warnings`.

**Closure (`closure`).** A full or partial road closure along a motorway (German
*Sperrung*). CLI: `closures`.

**Electric charging station (`electric_charging_station`).** An EV charging point
along a motorway (German *E-Ladestation*). Connectors, power and point count are
lines in `description`, not separate fields. CLI: `charging`.

> The six service resources — roadworks, webcams, parking, warnings, closures,
> charging — are **structurally identical**: each supports `list <roadId>` and
> `get <identifier>`. Internally one generic `ServiceResource` serves all six.

---

## Identifiers & request shape

**`roadId`.** The motorway designation used as a path segment, e.g. `A1`. Taken
from the `roads` command. The upstream API itself emits a few ids with a
trailing space next to their trimmed twin (e.g. `"A60"` and `"A60 "`), so the
client trims surrounding whitespace before use, and `client.roads()` (so also the
`roads` command) trims the list, drops blank ids and removes the duplicates.
A road id containing `/` is rejected (`AutobahnValidationError`, exit `1`) before any
request: the API decodes the client's `%2F` back to `/` and resolves `..`, so
`A1/../A2` would otherwise print the A2 data under an A1 command. So is `.` or `..`
(`Invalid roadId: "." and ".." are not ids.`).

**`identifier`.** The opaque id of a single service item, present as the
`identifier` field on every listed item. It is the value you pass to a
`get <identifier>` command (or `resource.get(...)`) to fetch that one item's full
detail payload. Its format varies by service: roadworks, warnings and closures use
plain strings (`2026-006680--vi-fbm.…`), parking uses ids like `DE-SL-000031`, and
charging uses a numeric id for Deutschlandnetz sites (`30388`) and a base64 id for
all others (`RUxFQ1RSSUNfQ0hBUkdJTkdfU1RBVElPTl9fMTkyMzE=`). The detail endpoint
resolves an identifier **regardless of the service** in its path, so a `get` under
the wrong service still succeeds: `roadworks get DE-SL-000009` returns that lorry
parking area (`"display_type": "PARKING"`) with exit `0`. Use the service the
identifier was listed under; `display_type` shows what the item really is.
The API echoes the identifier it resolved; an answer with any other `identifier` (or
none) raises `AutobahnParseError` (exit `1`) instead of printing another item.
Surrounding whitespace is trimmed before the request (no identifier has any). An
identifier containing `/` is rejected like such a road id: `x/../<id>` would otherwise
fetch `<id>`.

**Service listing.** The two-step access pattern of the API: `list(roadId)`
returns the array of items for a service along a motorway; `get(identifier)` then
fetches one item's full details by its identifier. A listing can include items of
**another** motorway where the two meet: 10 of 239 A1 roadworks in October 2026 were
titled for the A45, A255, A602 or A7 (works at an interchange or a feeder road). Read
the road from the `title`/`description`, not from the id you queried.

**Listing envelope.** A service-listing response is a JSON object that wraps its
array under a single key named after the service —
`{ "roadworks": [...] }`, `{ "webcam": [...] }`, `{ "parking_lorry": [...] }`,
`{ "warning": [...] }`, `{ "closure": [...] }`,
`{ "electric_charging_station": [...] }`. The client unwraps this key and returns
the bare array. The API sends the key even when a road has no items (`{ "webcam": [] }`);
any other 2xx body — an error object, a bare array, a string, a non-array under the
key — raises `AutobahnParseError` (exit `1`) rather than passing for "no items". So
does an item that is not a JSON object with a string `identifier`. The same holds for
the `roads` array of the motorway list (strings only).

---

## Item fields

Every listed item shares one loosely specified shape (`AutobahnServiceItem`);
the API populates a different subset of fields per service type.

**`identifier`.** Opaque id of the item (see above).

**`title` / `subtitle`.** Short human-readable labels for the item. On lorry
parking the upstream `title` is broken (`A8 | undefined`); the area name is in
`subtitle`. On roadworks, warnings and closures the `subtitle` is the direction and
usually starts with a space (`" Saarbrücken -> Trier"`); trim it before matching or
splitting on `" -> "`. The client passes it on unchanged.

**`description`.** An array of descriptive text lines. Its times are German local time,
except the event line of an INRIX warning (`Unfall, seit 04.10.2026, 19:53`), which is UTC
without a zone marker — two hours behind the same item's `Beginn: … 21:53 Uhr` in summer.

**`point`.** A single geographic position serialised as a string. The order
varies by service: `"lat,long"` for roadworks, warnings and closures,
`"long,lat"` for charging. Lorry parking has none: listing items carry no `point`
key at all, and the `get` detail response has `point: null`.

**`coordinate`.** A geographic point as a structured object. Its shape varies by
service: `{ lat, long }` with JSON numbers for roadworks, warnings and closures;
the same keys as stringified decimals for charging; and a GeoJSON Point
`{ "type": "Point", "coordinates": [long, lat] }` with no `lat`/`long` keys for
lorry parking.

**`geometry`.** A GeoJSON `LineString` of the affected stretch, already in
`[long, lat]` order, on roadworks, warnings and closures.

**`extent`.** A bounding extent for the item (e.g. the span a roadworks covers): two
positions in one string, in the same order as `point` — `"lat,long,lat,long"` for
roadworks, warnings and closures, `"long,lat,long,lat"` for charging (a single site, so
both positions are equal). Like `point`, it is absent from lorry-parking listings and
`null` in their detail response.

**`isBlocked`.** A string flag (`"true"`/`"false"`) indicating whether the
segment/item is blocked. The API rarely sets it: it was `"false"` on all 306 A1
warnings, closures and roadworks in October 2026, including full closures
(`Vollsperrung` in the description). Read `"false"` as "not stated", not as "open".

**`future`.** Boolean — whether the item refers to a future (not yet active)
event, e.g. planned roadworks.

**`startTimestamp`.** When the event/item starts. An ISO time on roadworks, warnings
and closures; a German date on charging stations (`"30.03.2026"`, DD.MM.YYYY, which
`Date.parse` cannot read), where it can also be missing. Lorry parking has none: absent
from listing items, `null` in the detail response. The ISO times mix offsets, and the
data source decides which, not the service: INRIX warnings (`source: "inrix"`) use UTC
(`2026-10-04T15:24:00Z`), warnings from the traffic centres (`source: "eva"`) and the
roadworks and closures German local time (`2026-10-04T20:57:00+02:00`). Compare them as
parsed dates, never as strings.

**`delayTimeValue`.** The delay in minutes on a traffic warning, sent as a JSON
**string** (`"10"`). Convert it to a number before sorting or comparing: as strings,
`"5"` sorts above `"37"`.

**`display_type`.** A type/category hint the app uses to render the item, and the
best signal of what an item is. Values seen live: `ROADWORKS`, `SHORT_TERM_ROADWORKS`,
`WARNING`, `CLOSURE`, `CLOSURE_ENTRY_EXIT`, `PARKING`, `ELECTRIC_CHARGING_STATION`,
`STRONG_ELECTRIC_CHARGING_STATION`. `CLOSURE_ENTRY_EXIT` is a closed on- or off-ramp at a
junction, not a closed carriageway, and makes up most of a road's closures (48 of 54 on
the A1 in October 2026). The service does not fix the type: a warnings listing can carry
a real-time `CLOSURE` that the closures listing does not have.

**`icon`, `footer`, `routeRecommendation`.** Display metadata: an icon key,
footer text lines, and any recommended-route lines.

**`imageurl` / `linkurl` (webcams).** The camera snapshot URL and a link URL.

**`operator` (webcams).** The operating organisation for a webcam. Charging stations
have **no** `operator` field: a Deutschlandnetz site (numeric `identifier`) names its
operator in `description` (`Ladesäulenbetreiber: …`), the other sites not at all.

**Detail payload.** The single-item response from a `get` is returned as a
faithful raw `JsonObject` (`RoadworkDetail`, `WebcamDetail`, … are all aliases of
`JsonObject`) rather than a partially-guessed type, because the detail shape
varies and is not fully specified.

---

## Behaviour, errors & limits

**Empty-body not-found.** The detail endpoint answers an **unknown identifier with
HTTP 200 and an empty body** rather than a `404`. The client treats an empty (or
whitespace-only) body as not-found and raises an `AutobahnNotFoundError` (CLI exit
code `4`) that names the status really sent — `Not found: the API answered HTTP 200 with
an empty body for GET <url>` — instead of a misleading JSON parse error.
This applies to `get` only: an empty body from the road list or a service listing
is a broken response, not a missing resource, and raises `AutobahnParseError`
(exit `1`).

**Empty list vs not-found.** A `list <roadId>` that matches no items is **not**
an error: it returns `[]` (exit `0`). The API answers an **unknown road id** (a
typo, or `a1` for `A1` — ids are case-sensitive) with the same empty listing and
HTTP 200, so when a listing is empty the client checks the id against the road
list and raises `AutobahnNotFoundError` (exit `4`, with a did-you-mean for a case
slip, a space or dash, or a leading zero: `a1`, `A 1`, `A-1`, `A01` → `A1`) if it is not there. That check is a second request with its own timeout and
retries; if it fails, the listing raises an `AutobahnError` (exit `1`,
`Could not check road id … against the API's road list …`, the original error as
`cause`) rather than an all-clear. A `get <id>` with no matching item, or a real `404`, is
not-found too (exit `4`).

**Retryable status.** `429` (rate-limited), `503` (service unavailable) and the
gateway errors `502` (bad gateway) and `504` (gateway timeout) are treated as
transient — a `502` seen live cleared within seconds. The engine retries them
automatically up to `maxRetries` (default `2`), honouring a `Retry-After` header
when present, otherwise using linear backoff. `AutobahnApiError.isRetryable`
reflects this. When the status persists, the error says so — `… (after 2 retries)` — and
`AutobahnApiError.retries` holds the count. A connection reset mid-request
(`socket hang up`, `ECONNRESET`) is retried the same way, with the linear backoff. A
**timeout is not retried** (a slow upstream is not asked again at once; `--timeout`
bounds each attempt), and neither is a refused connection or a DNS failure.

**`Retry-After`.** A response header the engine parses for both the
delta-seconds form (`Retry-After: 120`) and the HTTP-date form
(`Retry-After: Wed, 21 Oct 2025 07:28:00 GMT`) to decide how long to wait before
a retry. The resulting delay is clamped to a 30s ceiling so a pathological or
hostile value cannot hang the CLI for hours. Any other value (a fraction such as
`1.5`, a negative number, another date format) is ignored and the linear backoff
applies — never an instant retry.

**Redirects not followed.** A `3xx` response surfaces as an error rather than
being chased to another host (a deliberate safety choice, since `--base-url` is
trusted input). The error names the target — `…: redirect to <url> not followed`,
or `redirect not followed (no Location header)` — so you can point `--base-url`
there yourself.

**`maxResponseBytes`.** A hard cap on response body size (default 100 MiB; `0`
disables) that defends against memory exhaustion from a hostile or buggy
endpoint.

**Exit codes.** `0` success (incl. `--help`/`--version`); `4` not-found (`404`,
an unmatched `get` or an unknown road id); `1` any other API/network/parse error and
usage errors.

---

> **Library & internals.** Terms for the TypeScript client and its internals —
> `AutobahnClient`, the request engine, transport, retry/backoff, error types,
> query builder, DI seams — now live in **[DEVELOPING.md](DEVELOPING.md)**.
