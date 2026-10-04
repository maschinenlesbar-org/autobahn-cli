# Examples

Real examples for the Claude Code skills of the `autobahn` plugin, one per skill: a request,
the `autobahn` commands the skill ran, and the answer Claude gave.

Every example ran against the live API; each section says when and with which `autobahn`.
The data changes, so your results will differ; the ids and keys shown work for trying the
requests yourself. Long lists are shortened.

To try them, install the CLI and the plugin — see [SKILLS.md](SKILLS.md).

Skills: [autobahn-ev-planner](#autobahn-ev-planner) · [autobahn-map](#autobahn-map) · [autobahn-route-check](#autobahn-route-check)

## autobahn-ev-planner

Ran on 4 October 2026 with the build released as `autobahn` 0.2.0 later that evening.

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

Ran on 15 September 2026 with `autobahn` 0.0.7.

> I dispatch lorries on the A8. Give me the truck parking areas and the current traffic warnings as a GeoJSON file for QGIS.

```bash
autobahn --compact roads
autobahn --compact parking list A8
autobahn --compact warnings list A8
```

The parking items no longer carry `coordinate.lat`/`coordinate.long`: `coordinate` is now a GeoJSON
Point (`{"type":"Point","coordinates":[6.373376,49.483848]}`) with no `point` string. The skill's
per-item snippet would have written `[null, null]` for all 71 areas, so the export read x/y from
`coordinate.coordinates` and checked every pair before writing. Parking titles read `A8 | undefined`,
so the area name comes from `subtitle`.

```
Wrote autobahn-A8-parking-warnings.geojson — one FeatureCollection, 78 features, 64 KB, 0 skipped
  parking   71 × Point        DE-SL-000031 (RA Moseltal N, Saarland) … DE-BY-… (Bayern)
  warnings   7 × LineString   affected stretch from each warning's own geometry
Properties: road, service, subtitle, display_type, isBlocked, future, identifier,
  description ("PKW Stellplätze: 20\nLKW Stellplätze: 16"); warnings add
  startTimestamp, delayTimeValue, abnormalTrafficType.

Largest lorry areas: Denkendorf 123 LKW spaces (DE-BW-008040), Gruibingen 112,
  Leipheim S 88, Aichen N 79, Samerberg N 69 — 1,990 lorry spaces in total.
Worst warning: Heimsheim – Pforzheim-Nord (Stuttgart → Karlsruhe), +43 min, QUEUING_TRAFFIC.
Checked: every coordinate is a [lon, lat] number pair inside Germany; the file parses as
  a single FeatureCollection.
```

Next steps offered: drag the file onto https://geojson.io, or re-export pretty-printed.

## autobahn-route-check

Ran on 4 October 2026 at 21:10 with the build released as `autobahn` 0.2.0 later that evening.

> I'm driving from Frankfurt to Köln on the A3 this evening. Anything I should know about?

```bash
autobahn --compact roads
autobahn --compact warnings  list A3
autobahn --compact closures  list A3
autobahn --compact roadworks list A3
```

The A3 runs to Passau, so the skill kept only items inside a box around the two cities (lat
50.0–51.0, lon 6.9–8.75). That box holds no carriageway closure (`display_type: "CLOSURE"`), only
three ramp closures (`CLOSURE_ENTRY_EXIT`), which the skill counts apart from the road. The AS
Montabaur ramp has `future: false`, but its `Die Baustelle ist zu folgenden Zeiträumen gültig:`
windows start tomorrow at 19:00, so it counts as planned. The one warning has no
`delayTimeValue` and no `abnormalTrafficType` (an `Ereignismeldung`), so it is information,
not a jam. 10 of the 72 roadworks in the box are titled for a project rather than `A3 | …`
(the Offenbacher Kreuz rebuild, AK Bonn/Siegburg – Siebengebirge); they are in the count.

```
A3 Frankfurt → Köln — ✓ clear tonight: no closures, no blocking roadworks, no jams
     (this stretch: 1 warning / 0 closures + 3 ramp closures / 72 roadworks — 42 active,
      none blocking; whole A3: 1 / 1 + 24 ramp / 171)
  ⓘ  A3 Köln → Frankfurt, Limburg-Süd – Idstein: Fahrbahnschäden since 09.09.
     (other carriageway, no delay stated)

Planned ramp closures (none active tonight):
  🚧 AS Montabaur, on-ramp from Montabaur: 05.10. 19:00 – 06.10. 05:00 and 12.10. 20:00 – 13.10. 05:00
  🚧 AS Siebengebirge, on- and off-ramp of the Köln → Frankfurt carriageway: 05.10. 05:00 – 16.10. 05:00
No detour recommendations were published for any of these.
```

Next steps offered: full detail on any item (`autobahn warnings get <identifier>`), or the same check for the return trip.
