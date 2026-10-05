# Beispiele

Echte Beispiele für die Claude-Code-Skills des Plugins `autobahn`, eines pro Skill: eine
Anfrage, die `autobahn`-Befehle, die der Skill ausgeführt hat, und Claudes Antwort.

Jedes Beispiel lief gegen die Live-API; jeder Abschnitt nennt Datum und `autobahn`-Version.
Die Daten ändern sich, Ihre Ergebnisse werden also abweichen; mit den gezeigten IDs und
Schlüsseln können Sie die Anfragen selbst ausprobieren. Lange Listen sind gekürzt.

Zum Ausprobieren installieren Sie die CLI und das Plugin – siehe [SKILLS.md](SKILLS.md) (englisch).

Skills: [autobahn-ev-planner](#autobahn-ev-planner) · [autobahn-map](#autobahn-map) · [autobahn-route-check](#autobahn-route-check)

## autobahn-ev-planner

Lief am 6. Oktober 2026 um 00:28 Uhr mit `autobahn` 0.5.0.

> Mit dem E-Auto über die A7 von Hamburg nach Göttingen – wo gibt es unterwegs Schnelllader?

```bash
autobahn --compact roads
autobahn --compact charging list A7
autobahn --compact charging get RUxFQ1RSSUNfQ0hBUkdJTkdfU1RBVElPTl9fMTE5NDg=   # Base64-ID funktioniert auch
```

Die A7 lieferte 65 Standorte, von Ellund an der dänischen Grenze bis Rottachtal im Allgäu. Der
Skill sortierte sie nach Breitengrad und behielt die 17 zwischen Hamburg und Göttingen. Der
mittlere Teil jedes `title` nennt die Fahrtrichtung (`Hannover`/`Göttingen`/`Kassel`/`Reutte` bei den
West-Anlagen, `Hamburg`/`Appenrade` bei den Ost-Anlagen), deshalb zeigt er die Seite Richtung
Süden. 16 der 17 tragen `STRONG_ELECTRIC_CHARGING_STATION`, auch reine 50-kW-Standorte – die
Ladeleistung las der Skill deshalb aus den kW-Zeilen in `description[]`, jede Zeile zuvor getrimmt
(Wolfsgrund W sendet die Zahl der Ladepunkte als `"4 Ladepunkte "`).

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
Betreiber, Stecker und Leistung je Ladepunkt aus dem Ladesäulenregister (die CLI `ladesaeulen`).

## autobahn-map

Lief am 6. Oktober 2026 um 00:28 Uhr mit `autobahn` 0.5.0.

> Für die Lkw-Disposition auf der A8: Lkw-Parkplätze und aktuelle Verkehrswarnungen als GeoJSON-Datei für QGIS.

```bash
autobahn --compact roads
autobahn --compact parking list A8
autobahn --compact warnings list A8
```

Parkplatz-Einträge tragen `coordinate` als GeoJSON-Point (`{"type":"Point","coordinates":[lon,lat]}`)
und keinen `point`-String. Der Export las x/y deshalb aus `coordinate.coordinates`, wie es
`lonLat()` im Skill tut, und prüfte jedes Paar vor dem Schreiben. Die Titel der Parkplätze lauten
`A8 | undefined`, der Name steht in `subtitle`. Kurz nach Mitternacht hatte die A8 keine Warnungen:
`warnings list` lieferte `[]` mit Exit-Code 0 – eine leere Ebene, keine fehlgeschlagene, die Datei
ist also vollständig.

```
autobahn-A8-parking-warnings.geojson geschrieben – eine FeatureCollection, 71 Features, 21 KB, 0 übersprungen
  parking   71 × Point        DE-BW-… (Baden-Württemberg) … DE-SL-000520 (Saarland)
  warnings   0                um 00:28 Uhr keine auf der A8 (leere Antwort, Exit-Code 0)
Properties: road, service, subtitle, display_type, isBlocked, future, identifier,
  description ("PKW Stellplätze: 20\nLKW Stellplätze: 16").

Größte Lkw-Parkplätze: Denkendorf 123 Lkw-Stellplätze (DE-BW-008040), Gruibingen 112,
  Leipheim S 88, Aichen N 79, Samerberg N 69 – insgesamt 1.990 Lkw-Stellplätze.
Geprüft: Jede Koordinate ist ein [lon, lat]-Zahlenpaar innerhalb Deutschlands; die Datei
  lässt sich als eine einzige FeatureCollection parsen.
```

Als Nächstes angeboten: die Datei auf https://geojson.io ziehen, eingerückt neu exportieren oder
tagsüber erneut ausführen, wenn die A8 meist Warnungen hat.

## autobahn-route-check

Lief am 6. Oktober 2026 um 00:27 Uhr mit `autobahn` 0.5.0.

> Heute Nacht auf der A3 von Frankfurt nach Köln – gibt es etwas zu beachten?

```bash
autobahn --compact roads
autobahn --compact warnings  list A3
autobahn --compact closures  list A3
autobahn --compact roadworks list A3
```

Die A3 reicht bis Passau, deshalb behielt der Skill nur Einträge in einem Rechteck um beide
Städte (Breite 50,0–51,0, Länge 6,9–8,75): 2 Warnungen, 3 Sperrungen von Auf- oder Abfahrten
(`CLOSURE_ENTRY_EXIT`, getrennt von der Autobahn gezählt) und 76 Baustellen. Die einzige Warnung
mit Verzögerung liegt auf der Fahrbahn des Nutzers: `QUEUING_TRAFFIC`, 35 Minuten, „Im Stillstand".
Ihre `Beginn:`-Zeile nennt 00:05 Uhr, die INRIX-Ereigniszeile `seit 05.10.2026, 22:05` – die ist
UTC, die Auskunft nennt daher 00:05 Uhr. Von den 76 Baustellen haben 45 ein Zeitfenster, das jetzt
gilt – meist kurzfristige Nachtbaustellen mit `06.10.26 von 00:00 bis 05:00 Uhr` –, keine nennt
eine `Vollsperrung`. Der Skill las jedes Zeitfenster statt `future`: 31 sind geplant, und eine
Baustelle an der AS Montabaur mit `future: false` beginnt erst am 06.10. um 19:00 Uhr. 15 Baustellen
tragen den Namen eines Projekts statt `A3 | …`; sie sind mitgezählt. `isBlocked` war bei jedem
Eintrag `"false"`, `routeRecommendation` leer.

```
A3 Frankfurt → Köln – ⚠ befahrbar: ein Stau, keine Sperrungen, keine blockierenden Baustellen
     (dieser Abschnitt: 2 Warnungen / 0 Sperrungen + 3 Rampensperrungen / 76 Baustellen – 45 aktiv,
      keine blockiert; gesamte A3: 2 / 1 + 28 Rampen / 190)
  🐢 +35 min  QUEUING  A3 Frankfurt → Köln, Bad Camberg – Limburg-Süd: Stillstand seit 00:05 Uhr
  ⓘ  A3 Köln → Frankfurt, Limburg-Süd – Idstein: Fahrbahnschäden seit 09.09.
     (Gegenfahrbahn, keine Verzögerung angegeben)

Rampensperrungen auf diesem Abschnitt:
  🚧 AS Siebengebirge, Auf- und Abfahrt der Fahrbahn Köln → Frankfurt: aktiv bis 16.10. 05:00
  🚧 AS Montabaur, Auffahrt aus Richtung Montabaur (geplant): 07.10. 19:00 – 08.10. 05:00 und 14.10. 20:00 – 15.10. 05:00
Für keinen dieser Einträge wurde eine Umleitungsempfehlung veröffentlicht.
```

Als Nächstes angeboten: Details zum Stau (`autobahn warnings get <identifier>`, mit der ID aus diesem
Lauf – Warnungs-IDs werden neu vergeben) oder dieselbe Prüfung für die Rückfahrt.
