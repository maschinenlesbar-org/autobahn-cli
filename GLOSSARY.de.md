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
`imageurl` (das Standbild) und eine `linkurl`. CLI: `webcams`. Der Upstream-Dienst
listet derzeit **auf keiner geprüften Autobahn Webcams** (A1, A3, A7, A8, A99 im
September 2026): `webcams list` gibt `[]` aus – eine Datenlücke der Quelle, kein Fehler.

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
entfernt der Client vor der Verwendung umgebende Leerzeichen, und `client.roads()`
(also auch der Befehl `roads`) bereinigt die Liste, lässt leere IDs weg und entfernt
die Duplikate. Eine Autobahn-Kennung mit `/` wird vor jeder Anfrage abgelehnt
(`AutobahnValidationError`, Exit `1`): Die API decodiert das `%2F` des Clients zurück zu
`/` und löst `..` auf, sonst gäbe `A1/../A2` unter einem A1-Befehl die Daten der A2 aus.

**`identifier`.** Die opake ID eines einzelnen Dienst-Eintrags, die in jedem gelisteten
Eintrag als Feld `identifier` steht. Diesen Wert übergeben Sie einem
`get <identifier>`-Befehl (oder `resource.get(...)`), um die vollständigen Details genau
dieses Eintrags abzurufen. Das Format hängt vom Dienst ab: Baustellen, Warnungen und
Sperrungen nutzen einfache Zeichenketten (`2026-006680--vi-fbm.…`), Parkplätze IDs wie
`DE-SL-000031`, Ladestationen eine numerische ID bei Standorten des Deutschlandnetzes
(`30388`) und eine Base64-ID bei allen anderen
(`RUxFQ1RSSUNfQ0hBUkdJTkdfU1RBVElPTl9fMTkyMzE=`). Der Detail-Endpoint löst eine Kennung
**unabhängig vom Dienst** in seinem Pfad auf, daher gelingt auch ein `get` unter dem
falschen Dienst: `roadworks get DE-SL-000009` liefert diesen Lkw-Parkplatz
(`"display_type": "PARKING"`) mit Exit `0`. Verwenden Sie den Dienst, unter dem die
Kennung gelistet war; `display_type` zeigt, was der Eintrag tatsächlich ist.
Umgebende Leerzeichen werden vor der Anfrage entfernt (keine Kennung enthält welche).
Eine Kennung mit `/` wird wie eine solche Autobahn-Kennung abgelehnt: `x/../<id>` würde
sonst `<id>` abrufen.

**Dienstliste.** Das zweistufige Zugriffsmuster der API: `list(roadId)` liefert das Array
der Einträge eines Dienstes entlang einer Autobahn; `get(identifier)` ruft dann die
vollständigen Details eines Eintrags über seine Kennung ab. Eine Liste kann Einträge
einer **anderen** Autobahn enthalten, wo sich beide treffen: 10 von 239 Baustellen der
A1 trugen im Oktober 2026 einen Titel der A45, A255, A602 oder A7 (Arbeiten an einem
Autobahnkreuz oder Zubringer). Lesen Sie die Autobahn aus `title`/`description`, nicht
aus der abgefragten Kennung.

**Listenhülle.** Die Antwort einer Dienstliste ist ein JSON-Objekt, das sein Array unter
einem einzigen, nach dem Dienst benannten Schlüssel ablegt –
`{ "roadworks": [...] }`, `{ "webcam": [...] }`, `{ "parking_lorry": [...] }`,
`{ "warning": [...] }`, `{ "closure": [...] }`,
`{ "electric_charging_station": [...] }`. Der Client packt diesen Schlüssel aus und
liefert das reine Array. Die API sendet den Schlüssel auch dann, wenn eine Autobahn
keine Einträge hat (`{ "webcam": [] }`); jeder andere 2xx-Body – ein Fehlerobjekt, ein
bloßes Array, ein String, ein Nicht-Array unter dem Schlüssel – löst `AutobahnParseError`
aus (Exit `1`), statt als „keine Einträge“ durchzugehen. Ebenso ein Eintrag, der kein
JSON-Objekt mit einer String-`identifier` ist. Dasselbe gilt für das Array `roads` der
Autobahnliste (nur Strings).

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
`"long,lat"` bei Ladestationen. Lkw-Parkplätze haben keine: Listeneinträge enthalten den
Schlüssel `point` gar nicht, die `get`-Detailantwort hat `point: null`.

**`coordinate`.** Ein geografischer Punkt als strukturiertes Objekt. Seine Form hängt vom
Dienst ab: `{ lat, long }` mit JSON-Zahlen bei Baustellen, Warnungen und Sperrungen;
dieselben Schlüssel als Zeichenketten codierte Dezimalzahlen bei Ladestationen; und bei
Lkw-Parkplätzen ein GeoJSON-Point `{ "type": "Point", "coordinates": [long, lat] }` ohne
die Schlüssel `lat`/`long`.

**`geometry`.** Ein GeoJSON-`LineString` des betroffenen Abschnitts, bereits in der
Reihenfolge `[long, lat]`, bei Baustellen, Warnungen und Sperrungen.

**`extent`.** Eine räumliche Ausdehnung des Eintrags (z. B. der Abschnitt, den eine
Baustelle umfasst): zwei Positionen in einer Zeichenkette, in derselben Reihenfolge wie
`point` – `"lat,long,lat,long"` bei Baustellen, Warnungen und Sperrungen,
`"long,lat,long,lat"` bei Ladestationen (ein einzelner Standort, beide Positionen sind
gleich). Wie `point` fehlt sie in den Listeneinträgen der Lkw-Parkplätze und ist in deren
Detailantwort `null`.

**`isBlocked`.** Ein String-Flag (`"true"`/`"false"`), das angibt, ob der Abschnitt bzw.
Eintrag blockiert ist. Die API setzt es selten: Im Oktober 2026 stand es bei allen 306
Warnungen, Sperrungen und Baustellen der A1 auf `"false"`, auch bei Vollsperrungen
(`Vollsperrung` in der Beschreibung). Lesen Sie `"false"` als „nicht angegeben“, nicht als
„frei“.

**`future`.** Boolean – ob sich der Eintrag auf ein künftiges (noch nicht aktives)
Ereignis bezieht, z. B. eine geplante Baustelle.

**`startTimestamp`.** Beginn des Ereignisses bzw. Eintrags (eine ISO-Zeit). Lkw-Parkplätze
haben keinen: Er fehlt in den Listeneinträgen und ist in der Detailantwort `null`.

**`delayTimeValue`.** Die Verzögerung in Minuten bei einer Verkehrswarnung, gesendet als
JSON-**String** (`"10"`). Vor dem Sortieren oder Vergleichen in eine Zahl umwandeln: Als
Strings sortiert `"5"` vor `"37"`.

**`display_type`.** Ein Typ- bzw. Kategoriehinweis, den die App zur Darstellung des
Eintrags nutzt, und das beste Signal dafür, was ein Eintrag ist. Live beobachtete Werte:
`ROADWORKS`, `SHORT_TERM_ROADWORKS`, `WARNING`, `CLOSURE`, `CLOSURE_ENTRY_EXIT`, `PARKING`,
`ELECTRIC_CHARGING_STATION`, `STRONG_ELECTRIC_CHARGING_STATION`. `CLOSURE_ENTRY_EXIT` ist
eine gesperrte Auf- oder Abfahrt an einer Anschlussstelle, keine gesperrte Fahrbahn, und
macht den Großteil der Sperrungen einer Autobahn aus (48 von 54 auf der A1 im Oktober 2026).
Der Dienst legt den Typ nicht fest: Eine Warnungsliste kann eine Echtzeit-`CLOSURE`
enthalten, die in der Sperrungsliste fehlt.

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
Das gilt nur für `get`: Ein leerer Body von der Autobahnliste oder einer Dienstliste ist
eine fehlerhafte Antwort, keine fehlende Ressource, und löst `AutobahnParseError` aus
(Exit `1`).

**Leere Liste vs. nicht gefunden.** Ein `list <roadId>` ohne passende Einträge ist
**kein** Fehler: Es liefert `[]` (Exit `0`). Eine **unbekannte Autobahn-Kennung** (ein
Tippfehler oder `a1` statt `A1` – die Kennungen unterscheiden Groß- und Kleinschreibung)
beantwortet die API mit derselben leeren Liste und HTTP 200. Deshalb prüft der Client bei
einer leeren Liste die Kennung gegen die Autobahnliste und löst `AutobahnNotFoundError`
aus (Exit `4`, bei falscher Schreibweise mit einem Vorschlag), wenn sie dort fehlt. Diese
Prüfung ist eine zweite Anfrage mit eigenem Timeout und eigenen Wiederholungen; schlägt sie
fehl, löst die Liste einen `AutobahnError` aus (Exit `1`,
`Could not check road id … against the API's road list …`, der ursprüngliche Fehler als
`cause`) statt einer Entwarnung. Auch
ein `get <id>` ohne passenden Eintrag oder ein echter `404` gilt als „nicht gefunden“
(Exit `4`).

**Wiederholbarer Status.** `429` (Rate-Limit), `503` (Dienst nicht verfügbar) und die
Gateway-Fehler `502` (Bad Gateway) und `504` (Gateway Timeout) gelten als
vorübergehend – ein live beobachteter `502` war nach wenigen Sekunden behoben. Die Engine wiederholt sie
automatisch bis zu `maxRetries` Mal (Standard `2`), berücksichtigt dabei einen
vorhandenen `Retry-After`-Header und nutzt andernfalls linearen Backoff.
`AutobahnApiError.isRetryable` bildet das ab.

**`Retry-After`.** Ein Antwort-Header, den die Engine sowohl in der Sekundenform
(`Retry-After: 120`) als auch in der HTTP-Datumsform
(`Retry-After: Wed, 21 Oct 2025 07:28:00 GMT`) auswertet, um zu bestimmen, wie lange sie
vor einem erneuten Versuch wartet. Die resultierende Wartezeit ist auf höchstens 30 s
begrenzt, damit ein unsinniger oder böswilliger Wert die CLI nicht stundenlang blockiert.
Jeder andere Wert (ein Bruch wie `1.5`, eine negative Zahl, ein anderes Datumsformat) wird
ignoriert; dann gilt der lineare Backoff – nie ein sofortiger erneuter Versuch.

**Keine Weiterleitungen.** Eine `3xx`-Antwort wird als Fehler gemeldet, statt ihr zu
einem anderen Host zu folgen (eine bewusste Sicherheitsentscheidung, da `--base-url` als
vertrauenswürdige Eingabe gilt). Die Fehlermeldung nennt das Ziel –
`…: redirect to <url> not followed` bzw. `redirect not followed (no Location header)` –,
sodass Sie `--base-url` selbst dorthin richten können.

**`maxResponseBytes`.** Eine feste Obergrenze für die Größe des Antwort-Bodys (Standard
100 MiB; `0` deaktiviert sie), die vor Speichererschöpfung durch einen böswilligen oder
fehlerhaften Endpoint schützt.

**Exit-Codes.** `0` bei Erfolg (inkl. `--help`/`--version`); `4` bei „nicht gefunden“
(`404`, ein `get` ohne Treffer oder eine unbekannte Autobahn-Kennung); `1` bei jedem
anderen API-, Netzwerk- oder
Parse-Fehler sowie bei Bedienfehlern.

---

> **Bibliothek & Interna.** Begriffe zum TypeScript-Client und seinen Interna –
> `AutobahnClient`, die Request-Engine, Transport, Retry/Backoff, Fehlertypen,
> Query-Builder, DI-Seams – stehen jetzt in **[DEVELOPING.md](DEVELOPING.md)**.
