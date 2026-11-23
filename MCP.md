# autobahn-mcp

An [MCP](https://modelcontextprotocol.io/) server for the live traffic data of the German
motorways from [Die Autobahn GmbH des Bundes](https://autobahn.api.bund.dev/): warnings,
closures, roadworks, EV charging sites, lorry parking and webcams, per motorway, as tools for AI
agents. Read-only, no API key.

It is the MCP side of [autobahn-cli](https://github.com/maschinenlesbar-org/autobahn-cli),
built on the same typed client, and released with it.

## Install

```bash
npm i -g @maschinenlesbar.org/autobahn-mcp
```

This installs the **`autobahn-mcp`** command (Node.js 22.12+). Or run the container
image, for linux/amd64 and linux/arm64, which needs no Node.js:

```bash
docker run -i --rm ghcr.io/maschinenlesbar-org/autobahn-mcp:latest
```

## Connect a client

The server speaks MCP on stdio by default.

**Claude Code**

```bash
claude mcp add autobahn -- autobahn-mcp
# or with the image:
claude mcp add autobahn -- docker run -i --rm ghcr.io/maschinenlesbar-org/autobahn-mcp:latest
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{ "mcpServers": { "autobahn": { "command": "autobahn-mcp" } } }
```

**VS Code** (`.vscode/mcp.json`)

```json
{ "servers": { "autobahn": { "type": "stdio", "command": "autobahn-mcp" } } }
```

**Over HTTP** (Streamable HTTP, one endpoint `POST /mcp`):

```bash
autobahn-mcp --transport http            # http://127.0.0.1:3000/mcp
claude mcp add --transport http autobahn http://127.0.0.1:3000/mcp
```

In a container, publish the port on loopback only:
`docker run --rm -p 127.0.0.1:3000:3000 ghcr.io/maschinenlesbar-org/autobahn-mcp:latest --transport http --host 0.0.0.0 --allowed-hosts localhost,127.0.0.1`.

For scripts and shared configs, pin a release and its digest from the
[release notes](https://github.com/maschinenlesbar-org/autobahn-cli/releases) instead of
`latest`: `…/autobahn-mcp:<version>@sha256:<digest>`. Check an image's provenance with
`gh attestation verify oci://ghcr.io/maschinenlesbar-org/autobahn-mcp:<version> --repo maschinenlesbar-org/autobahn-cli`.

## Tools

| Tool | What it answers |
|---|---|
| `checkRoad` | Is a motorway clear: counts, the items that block it, hazard warnings, the longest delays. Ramp closures are counted apart and never mean the road is shut. |
| `findChargingStations` | Charging sites along a motorway in road order, with power, points, connectors and direction; optionally a minimum kW. |
| `listRoads` | The motorway ids (A1 … A99). |
| `listServiceItems` | One service's items along a motorway (roadworks, webcams, lorry parking, warnings, closures, charging), a page at a time. |
| `getServiceItem` | One item with all its fields. |

Every tool only reads. An answer is JSON (`structuredContent` and the same as text), with the
`source` it came from (whole, never cut like the data) and the data licence. A text over 2000 characters is cut and ends in
`…[cut, N characters in all]`, and the answer says `truncated`. An answer over `--max-result-chars` loses entries from the end of its lists, each
down to its first entry (so a page's `nextOffset` always moves on), then has its longest texts cut further
(each with that mark), and says `truncated`; one that can't be cut down so far is a tool error that says to ask for less. A failure is a tool error that
says what to change (one over 5000 characters loses its middle, never its end, where the reason
is).

## Options

```
--transport <stdio|http>   stdio (default), or Streamable HTTP on POST /mcp
--host <address>           HTTP: the address to listen on (default 127.0.0.1)
--port <n>                 HTTP: the port (default 3000)
--allowed-hosts <list>     HTTP: Host header names to answer (default localhost,127.0.0.1,[::1])
--allowed-origins <list>   HTTP: browser origins allowed to call, exactly (https://app.example.org); none by default
--auth-token-file <path>   HTTP: a file with the bearer token every request must send (mode 600, 32+ characters)
--base-url <url>           API base URL (default https://verkehr.autobahn.de)
--timeout <ms>             per upstream request (default 30000)
--call-timeout <ms>        per tool call, retries included (default 45000)
--max-result-chars <n>     cap on one tool result's JSON (default 25000)
--max-pages <n>            pages a tool reads per list and call (default 10)
--user-agent <ua>          User-Agent header value (Latin-1, one line)
--log-format <text|jsonl>  the log records on stderr (default text)
```

## What it does and doesn't do

- **Read-only.** No tool changes anything, here or upstream.
- **No authentication** on HTTP unless you give one. It listens on loopback by default; it checks
  the `Host` header and, from a browser, the `Origin` (only the origins given with
  `--allowed-origins`, matched exactly) against DNS rebinding and other web pages; a page on one
  of those origins gets CORS (its preflight answered, the answers readable). With
  `--auth-token-file <path>` every request must send `Authorization: Bearer <token>` (the file holds
  one token of at least 32 characters, mode 600, owned by the user the server runs as, a regular
  file (a FIFO is refused at once, never waited on); read once at start; `(umask 077; openssl rand
  -hex 32 > mcp-token)` makes one); anything else is answered 401.
  Exposed beyond localhost (it logs a warning then), it belongs behind a proxy that authenticates or
  at least terminates TLS.
- **Gentle with the upstream.** One server process sends at most 2 requests at a time and 120 a
  minute to the API, pauses on HTTP 429 (as long as its Retry-After asks, at most 30 s), and stops
  a tool call after its deadline (a tool that has read part of its answer by then may answer with
  that part, and says so). A request those limits would hold longer than it or its call may
  wait is not sent: the call fails at once, naming the limit and when to ask again (and the log says
  so).
- **Results are data.** Text from the API, keys included, is cleaned (control, bidi,
  zero-width, tag and other invisible characters removed, but an emoji keeps its joiners; a key that cleaning makes equal to another stays, as `name~2`),
  but it is still other people's text: a model can be told things in it. The server can't act on that (it has no tool that writes), but other tools in the same session could.
- **Stops cleanly.** On `docker stop` (SIGTERM) or Ctrl-C the HTTP server takes no new
  connection and lets calls in flight answer for up to 5 s, then exits 143 (130); a second signal
  ends it at once. On stdio a signal ends it at once; when stdin ends, it first answers the
  requests it has read (each within its call deadline), then exits.
- **In a container** it needs at least 12 processes and threads (`--pids-limit`) and about
  256 MB of memory.
- **Logs** go to stderr, one record per line; stdout carries only the protocol. A call that fails
  upstream or reaches its deadline leaves a WARN record naming the tool.
- **Never installs anything.**

## Licence

Code: AGPL-3.0-or-later or commercial
([LICENSING.md](https://github.com/maschinenlesbar-org/autobahn-cli/blob/main/LICENSING.md)).
Data: Die Autobahn GmbH des Bundes declares no licence on the API; the Datenlizenz Deutschland –
Namensnennung 2.0 of its other open data applies by analogy, so name the source
([DATA_LICENSE.md](https://github.com/maschinenlesbar-org/autobahn-cli/blob/main/DATA_LICENSE.md)).
Every result carries this note in its `licence` field.
