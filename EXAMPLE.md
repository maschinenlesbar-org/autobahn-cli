# Examples

Real examples for the Claude Code skills of the `autobahn` plugin, one per skill: a request,
the `autobahn` commands the skill ran, and the answer Claude gave.

Every example ran against the live API; each section says when and with which `autobahn`.
The data changes, so your results will differ; the ids and keys shown work for trying the
requests yourself. Long lists are shortened.

To try them, install the CLI and the plugin — see [SKILLS.md](SKILLS.md).

Skills: [autobahn-ev-planner](#autobahn-ev-planner) · [autobahn-map](#autobahn-map) · [autobahn-route-check](#autobahn-route-check)

## autobahn-ev-planner

Ran on 6 October 2026 at 00:28 with `autobahn` 0.5.0.

> I'm driving my EV from Hamburg down to Göttingen on the A7. Where can I fast-charge on the way?

```bash
autobahn --compact roads
autobahn --compact charging list A7
autobahn --compact charging get RUxFQ1RSSUNfQ0hBUkdJTkdfU1RBVElPTl9fMTE5NDg=   # base64 id works too
```

The A7 returned 65 sites, from Ellund at the Danish border to Rottachtal in the Allgäu; the skill sorted them by latitude and kept the
17 between Hamburg and Göttingen. The middle part of each `title` names the direction of travel
(`Hannover`/`Göttingen`/`Kassel`/`Reutte` on the West sites, `Hamburg`/`Appenrade` on the Ost sites), so it
listed the southbound side. 16 of the 17 carry `STRONG_ELECTRIC_CHARGING_STATION`, including plain
50 kW sites, so it judged speed by the kW lines in `description[]` instead, trimming each line
first (Wolfsgrund W sends its point count as `"4 Ladepunkte "`).

```
EV charging on the A7, Hamburg → Göttingen (southbound) — 17 sites in the stretch, none out of service
Southbound side: 10 sites, 6 with ≥150 kW. Operator is only stated for Deutschlandnetz sites.

 1. ⚡ Raststätte Seevetal West          2× 150 kW · CCS (1× also CHAdeMO)
       https://www.google.com/maps?q=53.3307,10.0430
 2. ⚡ Raststätte Hasselhöhe West        43 kW AC Typ 2 + 50 kW CCS/CHAdeMO · same spot as 1.
 3. ⚡ Brunautal West                    2× 300 kW · CCS (1× also CHAdeMO)
       https://www.google.com/maps?q=53.1093,9.9815
 4. ⚡ Lüneburger Heide West             4× 350 kW · CCS
       https://www.google.com/maps?q=53.1093,9.9817
 5. 🔌 AS Bispingen, Horstfeldweg 9      3× 22 kW + 1× 11 kW · AC Typ 2 socket · at the junction
 6. ⚡ Wolfsgrund W                      4 pts · 200+kW · CCS · E.ON Drive Infrastructure GmbH · Deutschlandnetz
       https://www.google.com/maps?q=52.8107,9.6795
 7. ⚡ Raststätte Wülferode West         2× 150 kW · CCS
       https://www.google.com/maps?q=52.3384,9.8656
 8. ⚡ Raststätte Hannover-Wülferode West 43 kW AC Typ 2 + 50 kW CCS/CHAdeMO
 9. ⚡ Göttingen West                    2× 300 kW · CCS (1× also CHAdeMO)
       https://www.google.com/maps?q=51.4948,9.8769
10. ⚡ Raststätte Göttingen West         43 kW AC Typ 2 + 50 kW CCS/CHAdeMO

Northbound counterparts (Seevetal Ost, Lüneburger Heide Ost 4× 350 kW, Brunautal Ost,
Wolfsgrund O, Hannover-Wülferode Ost …) are 7 more sites for the way back.
```

Next steps offered: full detail for one site (`autobahn charging get <identifier>`), or operator,
connector and power per charging point from the Ladesäulenregister (the `ladesaeulen` CLI).

## autobahn-map

Ran on 6 October 2026 at 00:28 with `autobahn` 0.5.0.

> I dispatch lorries on the A8. Give me the truck parking areas and the current traffic warnings as a GeoJSON file for QGIS.

```bash
autobahn --compact roads
autobahn --compact parking list A8
autobahn --compact warnings list A8
```

Parking items carry `coordinate` as a GeoJSON Point (`{"type":"Point","coordinates":[lon,lat]}`)
and no `point` string, so the export read x/y from `coordinate.coordinates`, as the skill's
`lonLat()` does, and checked every pair before writing. Parking titles read `A8 | undefined`, so
the area name comes from `subtitle`. Shortly after midnight the A8 had no warnings: `warnings list`
returned `[]` with exit 0 — an empty layer, not a failed one, so the file is complete.

```
Wrote autobahn-A8-parking-warnings.geojson — one FeatureCollection, 71 features, 21 KB, 0 skipped
  parking   71 × Point        DE-BW-… (Baden-Württemberg) … DE-SL-000520 (Saarland)
  warnings   0                none on the A8 at 00:28 (empty answer, exit 0)
Properties: road, service, subtitle, display_type, isBlocked, future, identifier,
  description ("PKW Stellplätze: 20\nLKW Stellplätze: 16").

Largest lorry areas: Denkendorf 123 LKW spaces (DE-BW-008040), Gruibingen 112,
  Leipheim S 88, Aichen N 79, Samerberg N 69 — 1,990 lorry spaces in total.
Checked: every coordinate is a [lon, lat] number pair inside Germany; the file parses as
  a single FeatureCollection.
```

Next steps offered: drag the file onto https://geojson.io, re-export pretty-printed, or run it
again in the daytime when the A8 usually carries warnings.

## autobahn-route-check

Ran on 6 October 2026 at 00:27 with `autobahn` 0.5.0.

> I'm driving from Frankfurt to Köln on the A3 tonight. Anything I should know about?

```bash
autobahn --compact roads
autobahn --compact warnings  list A3
autobahn --compact closures  list A3
autobahn --compact roadworks list A3
```

The A3 runs to Passau, so the skill kept only items inside a box around the two cities (lat
50.0–51.0, lon 6.9–8.75): 2 warnings, 3 ramp closures (`CLOSURE_ENTRY_EXIT`, counted apart
from the road) and 76 roadworks. The one warning with a delay is on the user's carriageway:
`QUEUING_TRAFFIC`, 35 minutes, "Im Stillstand". Its `Beginn:` line says 00:05 while the INRIX
event line says `seit 05.10.2026, 22:05` — that one is UTC, so the briefing quotes 00:05. Of the
76 roadworks, 45 have a window covering now — most are short-term night works whose windows run
`06.10.26 von 00:00 bis 05:00 Uhr` — and none says `Vollsperrung`. The skill read each window
rather than `future`: 31 are planned, and one AS Montabaur works item with `future: false` only
starts on 06.10. at 19:00. 15 roadworks are titled for a project rather than `A3 | …`; they are
in the count. `isBlocked` was `"false"` and `routeRecommendation` empty on every item.

```
A3 Frankfurt → Köln — ⚠ drivable: one jam, no closures, no blocking roadworks
     (this stretch: 2 warnings / 0 closures + 3 ramp closures / 76 roadworks — 45 active,
      none blocking; whole A3: 2 / 1 + 28 ramp / 190)
  🐢 +35 min  QUEUING  A3 Frankfurt → Köln, Bad Camberg – Limburg-Süd: standstill since 00:05
  ⓘ  A3 Köln → Frankfurt, Limburg-Süd – Idstein: Fahrbahnschäden since 09.09.
     (other carriageway, no delay stated)

Ramp closures on this stretch:
  🚧 AS Siebengebirge, on- and off-ramp of the Köln → Frankfurt carriageway: active until 16.10. 05:00
  🚧 AS Montabaur, on-ramp from Montabaur (planned): 07.10. 19:00 – 08.10. 05:00 and 14.10. 20:00 – 15.10. 05:00
No detour recommendations were published for any of these.
```

Next steps offered: full detail on the jam (`autobahn warnings get <identifier>`, with the id from
this run — warning ids are re-issued), or the same check for the return trip.
