# Glossar

Ein Nachschlagewerk für die Fachbegriffe und projektspezifischen Begriffe, die in
`autobahn-cli` verwendet werden. Die API ist die **offene Autobahn-App-API**
(`verkehr.autobahn.de`) der **Autobahn GmbH des Bundes**, die die Live-Daten hinter der
offiziellen Autobahn-App liefert. Die Fachdomäne sind die deutschen Autobahnen; dieses
Glossar nennt den in CLI und Client verwendeten englischen Begriff, wo sinnvoll neben dem
deutschen Originalbegriff.

---

## API & Betreiber

**Autobahn-App-API.** Die offene, rein lesende REST-API unter `verkehr.autobahn.de`
(von der Community dokumentiert unter `autobahn.api.bund.dev`). Sie stellt aktuelle
Verkehrsdaten für das Netz der Bundesautobahnen bereit. Alle Endpoints, die dieses Tool
nutzt, liegen unter der API-Wurzel `/o/autobahn` und benötigen **weder Authentifizierung
noch API-Schlüssel**.

**Autobahn GmbH (des Bundes).** Das bundeseigene Unternehmen, das die deutschen
*Bundesautobahnen* betreibt und unterhält und diese API veröffentlicht.

**API-Wurzel (`/o/autobahn`).** Das gemeinsame Pfadpräfix unterhalb der Basis-URL für
alle Endpoints: die Liste der Autobahnen (`/o/autobahn/`), die Dienstlisten je Autobahn
(`/o/autobahn/{roadId}/services/{service}`) und die Detail-Endpoints
(`/o/autobahn/details/{service}/{identifier}`).

---

## Zentrale Ressourcen

**Autobahn (`roadId`).** Eine deutsche Bundesautobahn, identifiziert durch ihre
Bezeichnung wie `A1`, `A2`, `A99`. `GET /o/autobahn/` liefert die vollständige Liste der
Autobahnen, die die API kennt (das Array `roads`). CLI: `roads`. Die `roadId` ist das
erforderliche Pfadsegment für jeden `list`-Befehl eines Dienstes.

**Baustellen (`roadworks`).** Laufende oder geplante Bau- und Unterhaltungsarbeiten
entlang einer Autobahn. CLI: `roadworks`.

**Webcam (`webcam`).** Eine Verkehrskamera an einer Autobahn; Einträge enthalten eine
`imageurl` (das Standbild) und eine `linkurl`. CLI: `webcams`.

**Lkw-Parkplätze (`parking_lorry`).** Lkw-Parkplätze bzw. Rastplätze entlang einer
Autobahn und Angaben zu ihrer Belegung. CLI: `parking`.

**Verkehrswarnung (`warning`).** Eine Verkehrsmeldung bzw. Verkehrswarnung entlang einer
Autobahn – z. B. Stau, Unfälle, Gefahren. CLI: `warnings`.

**Sperrung (`closure`).** Eine Voll- oder Teilsperrung entlang einer Autobahn.
CLI: `closures`.

**E-Ladestation (`electric_charging_station`).** Ein Ladepunkt für Elektrofahrzeuge
entlang einer Autobahn, mit Metadaten zu Steckern und Betreiber. CLI: `charging`.

> Die sechs Dienst-Ressourcen – Baustellen, Webcams, Parkplätze, Warnungen, Sperrungen,
> Ladestationen – sind **strukturell identisch**: Jede unterstützt `list <roadId>` und
> `get <identifier>`. Intern bedient eine generische `ServiceResource` alle sechs.

---

## Kennungen & Aufbau der Anfragen

**`roadId`.** Die Bezeichnung der Autobahn als Pfadsegment, z. B. `A1`. Sie stammt aus
dem Befehl `roads`. Die Upstream-API selbst liefert einige IDs mit nachgestelltem
Leerzeichen neben ihrem bereinigten Gegenstück (z. B. `"A60"` und `"A60 "`). Deshalb
entfernt der Client vor der Verwendung umgebende Leerzeichen, und der Befehl `roads`
bereinigt die ausgegebene Liste und entfernt die Duplikate.

**`identifier`.** Die opake ID eines einzelnen Dienst-Eintrags, die in jedem gelisteten
Eintrag als Feld `identifier` steht. Diesen Wert übergeben Sie einem
`get <identifier>`-Befehl (oder `resource.get(...)`), um die vollständigen Details genau
dieses Eintrags abzurufen. Das Format hängt vom Dienst ab: Baustellen, Warnungen und
Sperrungen nutzen einfache Zeichenketten (`2026-006680--vi-fbm.…`), Parkplätze IDs wie
`DE-SL-000031`, Ladestationen eine numerische ID bei Standorten des Deutschlandnetzes
(`30388`) und eine Base64-ID bei allen anderen
(`RUxFQ1RSSUNfQ0hBUkdJTkdfU1RBVElPTl9fMTkyMzE=`).

**Dienstliste.** Das zweistufige Zugriffsmuster der API: `list(roadId)` liefert das Array
der Einträge eines Dienstes entlang einer Autobahn; `get(identifier)` ruft dann die
vollständigen Details eines Eintrags über seine Kennung ab.

**Listenhülle.** Die Antwort einer Dienstliste ist ein JSON-Objekt, das sein Array unter
einem einzigen, nach dem Dienst benannten Schlüssel ablegt –
`{ "roadworks": [...] }`, `{ "webcam": [...] }`, `{ "parking_lorry": [...] }`,
`{ "warning": [...] }`, `{ "closure": [...] }`,
`{ "electric_charging_station": [...] }`. Der Client packt diesen Schlüssel aus und
liefert das reine Array. Die API sendet den Schlüssel auch dann, wenn eine Autobahn
keine Einträge hat (`{ "webcam": [] }`); jeder andere 2xx-Body – ein Fehlerobjekt, ein
bloßes Array, ein String, ein Nicht-Array unter dem Schlüssel – löst `AutobahnParseError`
aus (Exit `1`), statt als „keine Einträge“ durchzugehen. Dasselbe gilt für das Array
`roads` der Autobahnliste.

---

## Felder der Einträge

Alle gelisteten Einträge teilen eine lose spezifizierte Form (`AutobahnServiceItem`);
die API befüllt je Diensttyp eine andere Teilmenge der Felder.

**`identifier`.** Opake ID des Eintrags (siehe oben).

**`title` / `subtitle`.** Kurze, menschenlesbare Bezeichnungen des Eintrags. Bei den
Lkw-Parkplätzen ist `title` upstream fehlerhaft (`A8 | undefined`); der Name des
Parkplatzes steht in `subtitle`.

**`description`.** Ein Array beschreibender Textzeilen.

**`point`.** Eine einzelne geografische Position, serialisiert als Zeichenkette. Die
Reihenfolge hängt vom Dienst ab: `"lat,long"` bei Baustellen, Warnungen und Sperrungen,
`"long,lat"` bei Ladestationen. Lkw-Parkplätze haben `point: null`.

**`coordinate`.** Ein geografischer Punkt als strukturiertes Objekt. Seine Form hängt vom
Dienst ab: `{ lat, long }` mit JSON-Zahlen bei Baustellen, Warnungen und Sperrungen;
dieselben Schlüssel als Zeichenketten codierte Dezimalzahlen bei Ladestationen; und bei
Lkw-Parkplätzen ein GeoJSON-Point `{ "type": "Point", "coordinates": [long, lat] }` ohne
die Schlüssel `lat`/`long`.

**`geometry`.** Ein GeoJSON-`LineString` des betroffenen Abschnitts, bereits in der
Reihenfolge `[long, lat]`, bei Baustellen, Warnungen und Sperrungen.

**`extent`.** Eine räumliche Ausdehnung des Eintrags (z. B. der Abschnitt, den eine
Baustelle umfasst).

**`isBlocked`.** Ein String-Flag, das angibt, ob der Abschnitt bzw. Eintrag blockiert ist.

**`future`.** Boolean – ob sich der Eintrag auf ein künftiges (noch nicht aktives)
Ereignis bezieht, z. B. eine geplante Baustelle.

**`startTimestamp`.** Beginn des Ereignisses bzw. Eintrags.

**`display_type`.** Ein Typ- bzw. Kategoriehinweis, den die App zur Darstellung des
Eintrags nutzt.

**`icon`, `footer`, `routeRecommendation`.** Anzeige-Metadaten: ein Icon-Schlüssel,
Fußzeilen und etwaige Zeilen mit Umleitungsempfehlungen.

**`imageurl` / `linkurl` (Webcams).** Die URL des Kamerastandbilds und eine Link-URL.

**`operator` (Ladestationen/Webcams).** Die betreibende Organisation des Eintrags.

**Detailantwort.** Die Antwort eines `get` auf einen einzelnen Eintrag wird als
unverändertes rohes `JsonObject` zurückgegeben (`RoadworkDetail`, `WebcamDetail`, … sind
allesamt Aliase von `JsonObject`) statt als teilweise geratener Typ, weil die Form der
Details variiert und nicht vollständig spezifiziert ist.

---

## Verhalten, Fehler & Grenzen

**404 bei leerem Body.** Der Detail-Endpoint beantwortet eine **unbekannte Kennung mit
HTTP 200 und leerem Body** statt mit `404`. Der Client wertet einen leeren (oder nur aus
Leerraum bestehenden) Body als „nicht gefunden“ und löst einen synthetischen `404`
`AutobahnApiError` aus (CLI-Exit-Code `4`), statt eines irreführenden JSON-Parse-Fehlers.

**Leere Liste vs. nicht gefunden.** Ein `list <roadId>` ohne passende Einträge ist
**kein** Fehler: Es liefert `[]` (Exit `0`). Nur ein `get <id>` ohne passenden Eintrag
oder ein echter `404` gilt als „nicht gefunden“ (Exit `4`).

**Wiederholbarer Status.** `429` (Rate-Limit) und `503` (Dienst nicht verfügbar) sind
die Status, die die API als vorübergehend dokumentiert. Die Engine wiederholt sie
automatisch bis zu `maxRetries` Mal (Standard `2`), berücksichtigt dabei einen
vorhandenen `Retry-After`-Header und nutzt andernfalls linearen Backoff.
`AutobahnApiError.isRetryable` bildet das ab.

**`Retry-After`.** Ein Antwort-Header, den die Engine sowohl in der Sekundenform
(`Retry-After: 120`) als auch in der HTTP-Datumsform
(`Retry-After: Wed, 21 Oct 2025 07:28:00 GMT`) auswertet, um zu bestimmen, wie lange sie
vor einem erneuten Versuch wartet. Die resultierende Wartezeit ist auf höchstens 30 s
begrenzt, damit ein unsinniger oder böswilliger Wert die CLI nicht stundenlang blockiert.

**Keine Weiterleitungen.** Eine `3xx`-Antwort wird als Fehler gemeldet, statt ihr zu
einem anderen Host zu folgen (eine bewusste Sicherheitsentscheidung, da `--base-url` als
vertrauenswürdige Eingabe gilt).

**`maxResponseBytes`.** Eine feste Obergrenze für die Größe des Antwort-Bodys (Standard
100 MiB; `0` deaktiviert sie), die vor Speichererschöpfung durch einen böswilligen oder
fehlerhaften Endpoint schützt.

**Exit-Codes.** `0` bei Erfolg (inkl. `--help`/`--version`); `4` bei „nicht gefunden“
(`404` oder ein `get` ohne Treffer); `1` bei jedem anderen API-, Netzwerk- oder
Parse-Fehler sowie bei Bedienfehlern.

---

> **Bibliothek & Interna.** Begriffe zum TypeScript-Client und seinen Interna –
> `AutobahnClient`, die Request-Engine, Transport, Retry/Backoff, Fehlertypen,
> Query-Builder, DI-Seams – stehen jetzt in **[DEVELOPING.md](DEVELOPING.md)**.
