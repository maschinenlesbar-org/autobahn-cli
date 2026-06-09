---
name: autobahn-map
description: >
  Export Autobahn API data as valid GeoJSON for mapping, using the autobahn-cli.
  Trigger when the user asks to "map roadworks on the A99", "export A1 closures
  as GeoJSON", "show the charging stations on a map", "plot parking areas", or
  wants any motorway service as geodata for Leaflet / geojson.io / QGIS / Kibana.
  Fetches one or many services across one or many roads and emits a clean
  FeatureCollection — fixing the API's coordinate quirks.
version: 1.0.0
userInvocable: true
---

# Autobahn → GeoJSON Export

Turn any Autobahn service listing into a **valid GeoJSON `FeatureCollection`** ready for
geojson.io, Leaflet, QGIS, or Kibana — handling the coordinate quirks that make a naive
export wrong.

## Tooling

Data comes from the `autobahn` CLI (`@maschinenlesbar.org/autobahn-cli`) — read-only, no
key, **one motorway + one service per call**. Use whichever entrypoint exists:

- `autobahn …` (on `PATH`), else
- `npx @maschinenlesbar.org/autobahn-cli …`, else
- `node dist/src/cli/index.js …` from the `autobahn-cli` repo (`npm run build` first if
  `dist/` is missing).

Always `--compact`. Services: `roadworks`, `closures`, `warnings`, `parking`, `charging`,
`webcams`. An empty `[]` is a valid result (no items of that type on that road).

## Step 1 — Fetch

Identify the service(s) and road(s) the user wants and fetch each combination:

```bash
autobahn --compact roadworks list A99
autobahn --compact closures  list A99   # repeat per service / per road as needed
```

Validate road ids against `autobahn roads` first.

## Step 2 — Build the GeoJSON — coordinate handling is the whole job

For every item, emit one GeoJSON `Feature`.

> **The critical quirk: do NOT split the `point` string.** Its order is *inconsistent
> across services* — `roadworks` and `warnings` give `point: "lat,long"`, but `parking`
> and `charging` give `point: "long,lat"`. Splitting `point` will silently drop pins into
> the wrong hemisphere for half the services.
>
> **Always use the `coordinate` object**, which has explicit keys and is present on every
> item: `coordinate.lat` and `coordinate.long` (note `long`, not the RFC-7946 `lon`).
> Both are **strings** — `Number()` them.

GeoJSON requires `[longitude, latitude]` order (x, y). So:

```js
// per item
const lon = Number(item.coordinate.long);
const lat = Number(item.coordinate.lat);
const feature = {
  type: "Feature",
  geometry: { type: "Point", coordinates: [lon, lat] },   // [lon, lat], NOT [lat, lon]
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
- **Warnings carry a richer `geometry`** (a GeoJSON `LineString` of the affected stretch,
  already in `[lon, lat]` order). When present, prefer it over the point so the affected
  segment is drawn as a line; fall back to the `Point` from `coordinate` otherwise.
- Drop properties that are `undefined`/empty so the output stays clean.
- Skip any item missing `coordinate` (rare) and report how many were skipped.
- Wrap all features: `{ "type": "FeatureCollection", "features": [ … ] }`.

## Step 3 — Output

Write the FeatureCollection to a file the user can open (default
`./autobahn-<road>-<service>.geojson`, or a combined name for multi-service exports) and
report the feature count. Offer to:
- open it at https://geojson.io (paste / drag the file), or
- pretty-print vs compact (large roads can be 200+ features).

Validity checklist before you hand it over:
- coordinates are `[lon, lat]`, numbers not strings;
- `long` was used for x and `lat` for y (don't trust `point` order);
- it parses as JSON and is a single `FeatureCollection`.

## Known data gaps

- **Webcams currently return `[]` on every road tested** — the webcam service appears
  empty/dormant. If a webcam export comes back empty, that's the upstream data, not a
  bug; say so rather than implying the road has no cameras.
- Roadworks/closures volume is large (200+ per busy road). That's fine for a map layer,
  but warn the user before dumping it inline as text.
