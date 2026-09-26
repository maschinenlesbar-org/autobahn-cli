---
name: autobahn-map
description: >
  Export Autobahn API data as valid GeoJSON for mapping, using the autobahn-cli.
  Trigger when the user asks to "map roadworks on the A99", "export A1 closures
  as GeoJSON", "show the charging stations on a map", "plot parking areas", or
  wants any motorway service as geodata for Leaflet / geojson.io / QGIS / Kibana.
  Fetches one or many services across one or many roads and emits a clean
  FeatureCollection — fixing the API's coordinate quirks.
compatibility: >
  Requires the `autobahn` CLI (npm package @maschinenlesbar.org/autobahn-cli) on
  PATH, installed by the user; the skill never installs it. Network access to
  verkehr.autobahn.de.
---

# Autobahn → GeoJSON Export

Turn any Autobahn service listing into a **valid GeoJSON `FeatureCollection`** ready for
geojson.io, Leaflet, QGIS, or Kibana — handling the coordinate quirks that make a naive
export wrong.

## Tooling

This skill drives the `autobahn` command. **Before anything else, validate it is available** — run `command -v autobahn` (or `autobahn --version`). If it is not on your PATH, STOP and inform the user that the `autobahn` CLI (`@maschinenlesbar.org/autobahn-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

Data comes from the `autobahn` CLI (`@maschinenlesbar.org/autobahn-cli`) — read-only, no
key, **one motorway + one service per call**. Always `--compact`. Services: `roadworks`, `closures`, `warnings`, `parking`, `charging`,
`webcams`. An empty `[]` is a valid result (no items of that type on that road); an unknown
road id (ids are case-sensitive) exits `4` with `Unknown road id …` instead.

## Step 1 — Fetch

Identify the service(s) and road(s) the user wants and fetch each combination:

```bash
autobahn --compact roadworks list A99
autobahn --compact closures  list A99   # repeat per service / per road as needed
```

Validate road ids against `autobahn roads` first.

## Step 2 — Build the GeoJSON — coordinate handling is the whole job

For every item, emit one GeoJSON `Feature`.

> **The critical quirk: the position is stored differently per service.** Seen live on
> 2026-09-15:
>
> | Service | `coordinate` | `point` string | `geometry` |
> |---|---|---|---|
> | `roadworks`, `warnings`, `closures` | `{ lat, long }`, JSON **numbers** | `"lat,long"` | GeoJSON `LineString` of the affected stretch |
> | `charging` | `{ lat, long }`, **strings** | `"long,lat"` | none |
> | `parking` | a GeoJSON **Point**: `{ "type": "Point", "coordinates": [lon, lat] }`, no `lat`/`long` keys | `null` (`extent` too) | none |
>
> **Never split the `point` string** — its order flips between services, and parking has
> none. **Never read `coordinate.lat`/`.long` blindly either** — on parking they are
> `undefined`, and `Number(undefined)` writes `[null, null]` into the file. Handle both
> `coordinate` shapes (note the key is `long`, not the RFC-7946 `lon`) and check the
> result is a pair of finite numbers.

GeoJSON requires `[longitude, latitude]` order (x, y). So:

```js
// Returns [lon, lat] as numbers, or null when the item has no usable position.
const num = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));
function lonLat(item) {
  const c = item.coordinate;
  if (!c) return null;
  const xy = c.type === "Point" && Array.isArray(c.coordinates)
    ? [num(c.coordinates[0]), num(c.coordinates[1])]   // parking: already [lon, lat]
    : [num(c.long), num(c.lat)];                        // other services: numbers or strings
  return xy.every(Number.isFinite) ? xy : null;
}

// per item
const line = item.geometry?.type === "LineString" ? item.geometry : null;
const xy = lonLat(item);
if (!line && !xy) { skipped++; continue; }
const feature = {
  type: "Feature",
  geometry: line ?? { type: "Point", coordinates: xy },   // [lon, lat], NOT [lat, lon]
  properties: {
    road, service,
    title: item.title,
    subtitle: item.subtitle,
    display_type: item.display_type,
    isBlocked: item.isBlocked === "true",
    future: item.future === true,
    description: (item.description || []).join("\n"),
    identifier: item.identifier,
    imageurl: item.imageurl,    // webcams
    linkurl: item.linkurl,      // webcams
  },
};
```

Notes:
- **Roadworks, warnings and closures carry a `geometry`** (a GeoJSON `LineString` of the
  affected stretch, already in `[lon, lat]` order). Prefer it over the point so the
  affected segment is drawn as a line; fall back to the `Point` from `coordinate`
  otherwise.
- **Parking titles are broken upstream**: `title` reads `A8 | undefined` and `footer`
  `Koordinaten: undefined`. The area name is in `subtitle` (e.g. `RA Moseltal N`), so
  label parking features from `subtitle` and drop the broken `title`/`footer`.
- Drop properties that are `undefined`/empty so the output stays clean.
- Skip any item without a usable position and report how many were skipped.
- Wrap all features: `{ "type": "FeatureCollection", "features": [ … ] }`.

## Step 3 — Output

Write the FeatureCollection to a file the user can open (default
`./autobahn-<road>-<service>.geojson`, or a combined name for multi-service exports) and
report **the path you wrote and the feature count**. If a name the user supplied already
exists, confirm before overwriting it (re-running with the default name to refresh is fine).
Offer to:
- open it at https://geojson.io (paste / drag the file), or
- pretty-print vs compact (large roads can be 200+ features).

Validity checklist before you hand it over:
- coordinates are `[lon, lat]`, finite numbers — no strings, no `null`;
- x is `long` (or `coordinates[0]` on parking) and y is `lat` (don't trust `point` order);
- it parses as JSON and is a single `FeatureCollection`.

## Known data gaps

- **Webcams currently return `[]` on every road tested** — the webcam service appears
  empty/dormant. If a webcam export comes back empty, that's the upstream data, not a
  bug; say so rather than implying the road has no cameras.
- Roadworks/closures volume is large (200+ per busy road). That's fine for a map layer,
  but warn the user before dumping it inline as text.
