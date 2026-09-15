# Beispiele

Echte Beispiele für die Claude-Code-Skills des Plugins `autobahn`, eines pro Skill: eine
Anfrage, die `autobahn`-Befehle, die der Skill ausgeführt hat, und Claudes Antwort.

Jedes Beispiel lief am 15. September 2026 mit `autobahn` 0.0.7 gegen die Live-API.
Die Daten ändern sich, Ihre Ergebnisse werden also abweichen; mit den gezeigten IDs und
Schlüsseln können Sie die Anfragen selbst ausprobieren. Lange Listen sind gekürzt.

Zum Ausprobieren installieren Sie die CLI und das Plugin – siehe [SKILLS.md](SKILLS.md) (englisch).

Skills: [autobahn-ev-planner](#autobahn-ev-planner) · [autobahn-map](#autobahn-map) · [autobahn-route-check](#autobahn-route-check)

## autobahn-ev-planner

> Mit dem E-Auto über die A7 von Hamburg nach Göttingen – wo gibt es unterwegs Schnelllader?

```bash
autobahn --compact roads
autobahn --compact charging list A7
autobahn --compact charging get RUxFQ1RSSUNfQ0hBUkdJTkdfU1RBVElPTl9fMTE5NDc=   # Base64-ID funktioniert auch
```

Die A7 lieferte 65 Standorte, von Ellund an der dänischen Grenze bis Rottachtal im Allgäu. Der
Skill sortierte sie nach Breitengrad und behielt die 17 zwischen Hamburg und Göttingen. Der
mittlere Teil jedes `title` nennt die Fahrtrichtung (`Hannover`/`Kassel`/`Reutte` bei den
West-Anlagen, `Hamburg`/`Appenrade` bei den Ost-Anlagen), deshalb zeigt er die Seite Richtung
Süden. 16 der 17 tragen `STRONG_ELECTRIC_CHARGING_STATION`, auch reine 50-kW-Standorte – die
Ladeleistung las der Skill deshalb aus den kW-Zeilen in `description[]`.

```
Laden an der A7, Hamburg → Göttingen (Richtung Süden) – 17 Standorte auf der Strecke, keiner außer Betrieb
Richtung Süden: 10 Standorte, 6 davon mit ≥ 150 kW. Betreiber nur bei Deutschlandnetz-Standorten angegeben.

 1. ⚡ Raststätte Seevetal West          2× 150 kW · CCS (1× auch CHAdeMO)
       https://www.google.com/maps?q=53.3307,10.0430
 2. ⚡ Raststätte Hasselhöhe West        43 kW AC Typ 2 + 50 kW CCS/CHAdeMO · gleicher Ort wie 1.
 3. ⚡ Brunautal West                    2× 300 kW · CCS (1× auch CHAdeMO)
       https://www.google.com/maps?q=53.1093,9.9815
 4. ⚡ Lüneburger Heide West             4× 350 kW · CCS
       https://www.google.com/maps?q=53.1093,9.9817
 5. 🔌 AS Bispingen, Horstfeldweg 9      3× 22 kW + 1× 11 kW · AC-Typ-2-Steckdose · an der Anschlussstelle
 6. ⚡ Wolfsgrund W                      4 LP · 200+kW · CCS · E.ON Drive Infrastructure GmbH · Deutschlandnetz
       https://www.google.com/maps?q=52.8107,9.6795
 7. ⚡ Raststätte Wülferode West         2× 150 kW · CCS
       https://www.google.com/maps?q=52.3384,9.8656
 8. ⚡ Raststätte Hannover-Wülferode West 43 kW AC Typ 2 + 50 kW CCS/CHAdeMO
 9. ⚡ Göttingen West                    2× 300 kW · CCS (1× auch CHAdeMO)
       https://www.google.com/maps?q=51.4948,9.8769
10. ⚡ Raststätte Göttingen West         43 kW AC Typ 2 + 50 kW CCS/CHAdeMO

Gegenrichtung (Seevetal Ost, Lüneburger Heide Ost 4× 350 kW, Brunautal Ost,
Wolfsgrund O, Hannover-Wülferode Ost …): 7 weitere Standorte für die Rückfahrt.
```

Als Nächstes angeboten: alle Details zu einem Standort (`autobahn charging get <identifier>`) oder
Live-Verfügbarkeit und Tarife aus dem Ladesäulenregister.

## autobahn-map

> Für die Lkw-Disposition auf der A8: Lkw-Parkplätze und aktuelle Verkehrswarnungen als GeoJSON-Datei für QGIS.

```bash
autobahn --compact roads
autobahn --compact parking list A8
autobahn --compact warnings list A8
```

Die Parkplatz-Einträge haben kein `coordinate.lat`/`coordinate.long` mehr: `coordinate` ist jetzt
ein GeoJSON-Point (`{"type":"Point","coordinates":[6.373376,49.483848]}`), einen `point`-String
gibt es nicht. Das Code-Beispiel des Skills hätte für alle 71 Parkplätze `[null, null]`
geschrieben. Der Export las x/y deshalb aus `coordinate.coordinates` und prüfte jedes Paar vor dem
Schreiben. Die Titel der Parkplätze lauten `A8 | undefined`, der Name steht in `subtitle`.

```
autobahn-A8-parking-warnings.geojson geschrieben – eine FeatureCollection, 78 Features, 64 KB, 0 übersprungen
  parking   71 × Point        DE-SL-000031 (RA Moseltal N, Saarland) … DE-BY-… (Bayern)
  warnings   7 × LineString   betroffener Abschnitt aus der geometry der jeweiligen Warnung
Properties: road, service, subtitle, display_type, isBlocked, future, identifier,
  description ("PKW Stellplätze: 20\nLKW Stellplätze: 16"); Warnungen zusätzlich
  startTimestamp, delayTimeValue, abnormalTrafficType.

Größte Lkw-Parkplätze: Denkendorf 123 Lkw-Stellplätze (DE-BW-008040), Gruibingen 112,
  Leipheim S 88, Aichen N 79, Samerberg N 69 – insgesamt 1.990 Lkw-Stellplätze.
Schwerste Warnung: Heimsheim – Pforzheim-Nord (Stuttgart → Karlsruhe), +43 min, QUEUING_TRAFFIC.
Geprüft: Jede Koordinate ist ein [lon, lat]-Zahlenpaar innerhalb Deutschlands; die Datei
  lässt sich als eine einzige FeatureCollection parsen.
```

Als Nächstes angeboten: die Datei auf https://geojson.io ziehen oder eingerückt (pretty-printed) neu exportieren.

## autobahn-route-check

> Heute Abend auf der A3 von Frankfurt nach Köln – gibt es etwas zu beachten?

```bash
autobahn --compact roads
autobahn --compact warnings  list A3
autobahn --compact closures  list A3
autobahn --compact roadworks list A3
```

Die A3 reicht bis Passau, deshalb behielt der Skill nur Einträge in einem Rechteck um beide
Städte (Breite 50,0–51,0, Länge 6,9–8,75). Die Sperrung an der AS Idstein hat `future: false`,
ihr Zeitfenster in `description[]` liegt aber am 02.10.2026 – sie zählt daher als geplant, nicht
als aktiv.

```
A3 Frankfurt → Köln – ✓ befahrbar: derzeit nichts gesperrt oder blockiert, einige zähe Abschnitte
     (dieser Abschnitt: 5 Warnungen / 5 Sperrungen / 67 Baustellen – alle Sperrungen geplant,
      keine Baustelle blockiert; gesamte A3: 8 / 18 / 198)
  🐢 +11 min  SLOW  A3 Frankfurt → Oberhausen, Köln-Heumar – Leverkusen (falls es hinter Heumar weitergeht)
  🐢 +3 min   SLOW  A3 Frankfurt → Köln, Kelsterbach – Mönchhof-Dreieck, seit 17:07
  🐢 +3 min   SLOW  A3 Frankfurt → Würzburg, Frankfurt am Main-Süd – Offenbacher Kreuz (nicht auf der Route)
  ⓘ  A3 Köln → Frankfurt, Limburg-Süd – Idstein: Fahrbahnschäden seit 09.09. (Gegenfahrbahn, keine Verzögerung)

Geplant (heute Abend nicht aktiv):
  🚧 AS Siebengebirge, Frankfurt → Köln: Ausfahrt gesperrt 17.09. 20:00–24:00,
     Auffahrt gesperrt 17.09. 20:00 – 18.09. 05:00
  🚧 AD Dernbach, A3 → A48 Richtung Koblenz, beide Richtungen: 25.09. 20:00 – 28.09. 05:00
     (A48 Brückeninstandsetzung)
  🚧 AS Idstein, Ausfahrt aus Richtung Bad Camberg: 02.10. 09:00–14:00
Für keinen dieser Einträge wurde eine Umleitungsempfehlung veröffentlicht.
```

Als Nächstes angeboten: Details zu einem Eintrag (`autobahn warnings get <identifier>`) oder dieselbe Prüfung für die Rückfahrt.
