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
`imageurl` (the snapshot) and a `linkurl`. CLI: `webcams`.

**Parking lorry / lorry parking (`parking_lorry`).** Truck/HGV parking areas
along a motorway (German *Lkw-Parkplätze / Rastplätze*) and their occupancy
information. CLI: `parking`.

**Warning (`warning`).** A traffic warning along a motorway (German
*Verkehrsmeldung* / *Verkehrswarnung*) — e.g. congestion, accidents, hazards.
CLI: `warnings`.

**Closure (`closure`).** A full or partial road closure along a motorway (German
*Sperrung*). CLI: `closures`.

**Electric charging station (`electric_charging_station`).** An EV charging point
along a motorway (German *E-Ladestation*), with connector/operator metadata.
CLI: `charging`.

> The six service resources — roadworks, webcams, parking, warnings, closures,
> charging — are **structurally identical**: each supports `list <roadId>` and
> `get <identifier>`. Internally one generic `ServiceResource` serves all six.

---

## Identifiers & request shape

**`roadId`.** The motorway designation used as a path segment, e.g. `A1`. Taken
from the `roads` command. The client trims surrounding whitespace before use,
because the upstream API itself emits a few ids with a trailing space (e.g.
`"A60 "`).

**`identifier`.** The opaque, **base64-encoded** id of a single service item,
present as the `identifier` field on every listed item. It is the value you pass
to a `get <identifier>` command (or `resource.get(...)`) to fetch that one item's
full detail payload.

**Service listing.** The two-step access pattern of the API: `list(roadId)`
returns the array of items for a service along a motorway; `get(identifier)` then
fetches one item's full details by its base64 identifier.

**Listing envelope.** A service-listing response is a JSON object that wraps its
array under a single key named after the service —
`{ "roadworks": [...] }`, `{ "webcam": [...] }`, `{ "parking_lorry": [...] }`,
`{ "warning": [...] }`, `{ "closure": [...] }`,
`{ "electric_charging_station": [...] }`. The client unwraps this key and returns
the bare array (an empty array when the key is missing).

---

## Item fields

Every listed item shares one loosely specified shape (`AutobahnServiceItem`);
the API populates a different subset of fields per service type.

**`identifier`.** Base64 id of the item (see above).

**`title` / `subtitle`.** Short human-readable labels for the item.

**`description`.** An array of descriptive text lines.

**`point`.** A single geographic position serialised as a `"lat,long"` string,
present on most items.

**`coordinate`.** A geographic point as a structured object `{ lat, long }`,
where both `lat` and `long` are **stringified decimals** (the API serialises
coordinates as strings, not numbers).

**`extent`.** A bounding extent for the item (e.g. the span a roadworks covers).

**`isBlocked`.** A string flag indicating whether the segment/item is blocked.

**`future`.** Boolean — whether the item refers to a future (not yet active)
event, e.g. planned roadworks.

**`startTimestamp`.** When the event/item starts.

**`display_type`.** A type/category hint the app uses to render the item.

**`icon`, `footer`, `routeRecommendation`.** Display metadata: an icon key,
footer text lines, and any recommended-route lines.

**`imageurl` / `linkurl` (webcams).** The camera snapshot URL and a link URL.

**`operator` (charging/webcams).** The operating organisation for the item.

**Detail payload.** The single-item response from a `get` is returned as a
faithful raw `JsonObject` (`RoadworkDetail`, `WebcamDetail`, … are all aliases of
`JsonObject`) rather than a partially-guessed type, because the detail shape
varies and is not fully specified.

---

## Behaviour, errors & limits

**Empty-body 404.** The detail endpoint answers an **unknown identifier with
HTTP 200 and an empty body** rather than a `404`. The client treats an empty (or
whitespace-only) body as not-found and raises a synthetic `404`
`AutobahnApiError` (CLI exit code `4`), instead of a misleading JSON parse error.

**Empty list vs not-found.** A `list <roadId>` that matches no items is **not**
an error: it returns `[]` (exit `0`). Only a `get <id>` with no matching item, or
a real `404`, is treated as not-found (exit `4`).

**Retryable status.** `429` (rate-limited) and `503` (service unavailable) are
the statuses the API documents as transient. The engine retries them
automatically up to `maxRetries` (default `2`), honouring a `Retry-After` header
when present, otherwise using linear backoff. `AutobahnApiError.isRetryable`
reflects this.

**`Retry-After`.** A response header the engine parses for both the
delta-seconds form (`Retry-After: 120`) and the HTTP-date form
(`Retry-After: Wed, 21 Oct 2025 07:28:00 GMT`) to decide how long to wait before
a retry.

**Redirects not followed.** A `3xx` response surfaces as an error rather than
being chased to another host (a deliberate safety choice, since `--base-url` is
trusted input).

**`maxResponseBytes`.** A hard cap on response body size (default 100 MiB; `0`
disables) that defends against memory exhaustion from a hostile or buggy
endpoint.

**Exit codes.** `0` success (incl. `--help`/`--version`); `4` not-found (`404`
or an unmatched `get`); `1` any other API/network/parse error and usage errors.

---

> **Library & internals.** Terms for the TypeScript client and its internals —
> `AutobahnClient`, the request engine, transport, retry/backoff, error types,
> query builder, DI seams — now live in **[DEVELOPING.md](DEVELOPING.md)**.
