# Examples

Real examples for the Claude Code skills of the `autobahn` plugin, one per skill: a request,
the `autobahn` commands the skill ran, and the answer Claude gave.

Every example ran against the live API on 15 September 2026 with `autobahn` 0.0.7.
The data changes, so your results will differ; the ids and keys shown work for trying the
requests yourself. Long lists are shortened.

To try them, install the CLI and the plugin — see [SKILLS.md](SKILLS.md).

Skills: [autobahn-ev-planner](#autobahn-ev-planner) · [autobahn-map](#autobahn-map) · [autobahn-route-check](#autobahn-route-check)

## autobahn-ev-planner

> I'm driving my EV from Hamburg down to Göttingen on the A7. Where can I fast-charge on the way?

```bash
autobahn --compact roads
autobahn --compact charging list A7
autobahn --compact charging get RUxFQ1RSSUNfQ0hBUkdJTkdfU1RBVElPTl9fMTE5NDc=   # base64 id works too
```

The A7 returned 65 sites, from Ellund at the Danish border to Rottachtal in the Allgäu; the skill sorted them by latitude and kept the
17 between Hamburg and Göttingen. The middle part of each `title` names the direction of travel
(`Hannover`/`Kassel`/`Reutte` on the West sites, `Hamburg`/`Appenrade` on the Ost sites), so it
listed the southbound side. 16 of the 17 carry `STRONG_ELECTRIC_CHARGING_STATION`, including plain
50 kW sites, so it judged speed by the kW lines in `description[]` instead.

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

Next steps offered: full detail for one site (`autobahn charging get <identifier>`), or live
availability and tariffs from the Ladesäulenregister.

## autobahn-map

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

> I'm driving from Frankfurt to Köln on the A3 this evening. Anything I should know about?

```bash
autobahn --compact roads
autobahn --compact warnings  list A3
autobahn --compact closures  list A3
autobahn --compact roadworks list A3
```

The A3 runs to Passau, so the skill kept only items inside a box around the two cities (lat
50.0–51.0, lon 6.9–8.75). The AS Idstein closure has `future: false`, but its window in
`description[]` is 02.10.26, so it was counted as planned, not active.

```
A3 Frankfurt → Köln — ✓ drivable: nothing closed or blocked right now, a few slow patches
     (this stretch: 5 warnings / 5 closures / 67 roadworks — all closures planned, no roadwork
      blocking; whole A3: 8 / 18 / 198)
  🐢 +11 min  SLOW  A3 Frankfurt → Oberhausen, Köln-Heumar – Leverkusen (if you carry on past Heumar)
  🐢 +3 min   SLOW  A3 Frankfurt → Köln, Kelsterbach – Mönchhof-Dreieck, since 17:07
  🐢 +3 min   SLOW  A3 Frankfurt → Würzburg, Frankfurt am Main-Süd – Offenbacher Kreuz (not on your way)
  ⓘ  A3 Köln → Frankfurt, Limburg-Süd – Idstein: Fahrbahnschäden since 09.09. (other carriageway, no delay)

Planned (not active tonight):
  🚧 AS Siebengebirge, Frankfurt → Köln: exit closed 17.09. 20:00–24:00,
     on-ramp closed 17.09. 20:00 – 18.09. 05:00
  🚧 AD Dernbach, A3 → A48 towards Koblenz, both directions: 25.09. 20:00 – 28.09. 05:00
     (A48 Brückeninstandsetzung)
  🚧 AS Idstein, exit from Bad Camberg: 02.10. 09:00–14:00
No detour recommendations were published for any of these.
```

Next steps offered: full detail on any item (`autobahn warnings get <identifier>`), or the same check for the return trip.
