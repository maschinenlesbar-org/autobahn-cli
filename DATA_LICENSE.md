# Data license

> **This tool does not include, host, or redistribute any data.**
> `autobahn-cli` is a *client*. It only accesses data served live by **Die
> Autobahn GmbH des Bundes** over their public API. That data is the provider's
> and is governed by **their** terms, summarized below. The license of this CLI's
> own source code is a separate matter — see [LICENSING.md](LICENSING.md).

| | |
|---|---|
| **Data provider** | Die Autobahn GmbH des Bundes |
| **API / source** | `https://verkehr.autobahn.de` · docs: https://autobahn.api.bund.dev/ |
| **Data license** | **Not formally declared on the App API.** Autobahn GmbH open data on GovData carries **Datenlizenz Deutschland – Namensnennung 2.0 (`dl-de/by-2-0`)**; applied here by analogy. |
| **License text** | https://www.govdata.de/dl-de/by-2-0 |
| **Attribution** | Required if `dl-de/by-2-0` applies (see below). |
| **Commercial use** | Allowed under `dl-de/by-2-0`. |
| **Redistribution / modification** | Permitted under `dl-de/by-2-0` (copy, distribute, combine, modify) with attribution retained. |

## Attribution

If treating the data as `dl-de/by-2-0` (the safe default):

```
Datenquelle: Die Autobahn GmbH des Bundes —
Datenlizenz Deutschland – Namensnennung – Version 2.0 (dl-de/by-2-0),
https://www.govdata.de/dl-de/by-2-0
```

## Notes & caveats

- The App API endpoint (`verkehr.autobahn.de`) publishes **no** `license`/
  `termsOfService` in its OpenAPI `info` block — only a contact and a link to the
  Datenschutz page. The `dl-de/by-2-0` finding is grounded in Autobahn GmbH's
  GovData datasets (e.g. Verkehrszählung), not in this API's own metadata, so the
  mapping is **by analogy**. Attributing as `dl-de/by-2-0` is the conservative choice.
- Data is live/operational and explicitly disclaimed as **not guaranteed complete**
  ("ohne Anspruch auf Vollständigkeit").
- `api.bund.dev` / bundesAPI are community docs; their MIT-licensed spec does not
  govern the underlying data.

## Sources

- https://github.com/bundesAPI/autobahn-api — OpenAPI spec (`info` has no license/terms)
- https://www.govdata.de/dl-de/by-2-0 — DL-DE-BY-2.0 license text; Autobahn GmbH GovData datasets

---

*Good-faith summary compiled 2026-06-16; not legal advice. The provider's terms
are authoritative and can change — verify at the source before relying on the
data, especially for any commercial or redistribution use.*
