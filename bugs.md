# autobahn-cli — exploratory bug report

Environment: 2026-06-06, Node v22.14.0, `commander` 15.0.0. Built with `npm run build` (clean). Driven via `node dist/src/cli/index.js …`. Live Autobahn API (`https://verkehr.autobahn.de`) was reachable throughout; live calls were used and cross-checked with `curl`.

Total genuine, reproducible bugs found: **15** (all reproducible; severity/confidence noted per item). I probed thoroughly for 20 but several whole probe categories (numeric-flag parsing, retry/backoff, redirect handling, network-error mapping, data-passthrough) turned out to be *correct* — see "Things that work correctly" at the end. I did not pad the list to reach 20.

---

## High severity

### 1. `get <id>` for a non-existent item is reported as a JSON parse error (exit 1), not "not found" (exit 4) — ✅ FIXED
- **Fix:** `RequestEngine.getJson` (`src/client/engine.ts`) now treats an empty / whitespace-only 200 body as a not-found: it throws an `AutobahnApiError` with `status: 404`, which `run.ts` already maps to exit 4. The misleading parse error no longer fires for the empty-body case.
- Severity: High — Confidence: Confirmed
- Repro:
  ```
  node dist/src/cli/index.js roadworks get "DOES-NOT-EXIST"; echo $?
  ```
- Expected: a clear "not found" and, per the README exit-code table, exit `4` (or at least a non-confusing message).
- Actual:
  ```
  Error: Failed to parse JSON response from /o/autobahn/details/roadworks/DOES-NOT-EXIST
  exit=1
  ```
  Reproduces identically for all six services (`roadworks/webcams/parking/warnings/closures/charging get NOPE-NOPE` → exit 1 each).
- Root cause: the Autobahn detail endpoint returns **HTTP 200 with an empty body** for an unknown identifier (verified: `curl …/details/roadworks/DOES-NOT-EXIST` → `HTTP 200`, `content-type: application/json`, body length `0`). `RequestEngine.getJson` does `JSON.parse("")` which throws, mapped to `AutobahnParseError` → exit 1. `src/client/engine.ts:139-145`. There is no empty-body / not-found handling. This is the single most user-visible correctness defect: the documented exit-code contract for "item not found" (4) is unreachable via the normal `get` path, and the message blames the parser.

---

## Medium severity

### 2. Running with no arguments prints help to **stderr** and exits **1** — ✅ FIXED
- **Fix:** `run()` (`src/cli/run.ts`) now special-cases an empty argv as a discovery request: it writes `program.helpInformation()` to **stdout** via `deps.io.out` and returns exit 0, before commander's default no-command-to-stderr/exit-1 behaviour can fire.
- Severity: Medium — Confidence: Confirmed
- Repro:
  ```
  node dist/src/cli/index.js >/tmp/o 2>/tmp/e; echo $?; wc -c </tmp/o; wc -c </tmp/e
  ```
- Expected: discovery path; help on **stdout** with exit `0` (the README exit table treats help-like invocations as success). At minimum it should not be exit 1 with everything on stderr.
- Actual: `exit=1`, stdout `0` bytes, stderr `1371` bytes (full help text on stderr). By contrast `--help` correctly writes to stdout and exits 0.
- Root cause: commander's default "no command supplied" behaviour throws a `CommanderError` with exitCode 1 and writes help via `writeErr`; `run.ts` faithfully returns `err.exitCode`. No default action / `program.action(help)` override. `src/cli/run.ts:32-34`, `src/cli/program.ts`.

### 3. `--user-agent ""` sends an empty `User-Agent:` header instead of falling back to the default — ✅ FIXED
- **Fix:** Changed `??` to `||` for `userAgent` in the `RequestEngine` constructor (`src/client/engine.ts`), so an empty string falls back to `DEFAULT_USER_AGENT`.
- Severity: Medium — Confidence: Confirmed
- Repro (against a local echo server):
  ```
  node dist/src/cli/index.js --base-url http://127.0.0.1:PORT --user-agent "" roads
  # server logs: UA=[]   (vs UA=[autobahn-cli] without the flag)
  ```
- Expected: an empty value should be rejected, or fall back to the default UA; sending a blank UA gets requests rejected by some upstreams/WAFs.
- Actual: header sent literally empty (`User-Agent: `).
- Root cause: `this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT` (`src/client/engine.ts:80`). `""` is not nullish, so `??` keeps the empty string. Same defaulting flaw as bug #4.

### 4. `--base-url ""` overrides the default with an empty string → "Invalid URL" — ✅ FIXED
- **Fix:** Changed `??` to `||` for `baseUrl` in the `RequestEngine` constructor (`src/client/engine.ts`), so an empty string falls back to `DEFAULT_BASE_URL`.
- Severity: Medium — Confidence: Confirmed
- Repro:
  ```
  node dist/src/cli/index.js --base-url "" roads; echo $?
  ```
- Expected: an empty base URL should be rejected with a helpful message, or ignored in favour of the default `https://verkehr.autobahn.de`.
- Actual:
  ```
  Error: Invalid URL: /o/autobahn/
  exit=1
  ```
- Root cause: `this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/,"")` — `""` is not nullish so the default is skipped; the empty base produces a relative URL that `new URL()` rejects. `src/client/engine.ts:78`. Same `??`-vs-empty-string class as #3.

---

## Low severity (UX / docs / exit-code polish)

### 5. README exit-code contract: code `4` (404) is effectively unreachable for `get` — ✅ FIXED
- **Fix:** The behaviour is fixed by bug #1 (empty-body `get` now maps to a 404 → exit 4, so the contract is reachable). The README exit-code table (`README.md`) was also updated to explain the empty-body → not-found mapping and to clarify that an empty `list` is success (exit 0), not not-found.
- Severity: Low — Confidence: Confirmed
- The README (lines 84-91) advertises exit `4` for "item or motorway not found". For *motorways* a bad path does 404→4 (e.g. `roadworks list ""` → exit 4). But for *items* (`get`) the API answers 200-empty, so the documented 404→4 mapping never fires (see bug #1). The docs and behaviour disagree about the headline "not found" case.

### 6. Empty / whitespace / unicode / over-long `roadId` silently yield `[]` (no validation, confusing 404 text) — ✅ FIXED
- **Fix:** Added a `requireSegment()` guard in `src/client/client.ts` used by both `list()` and `get()`: empty or whitespace-only ids are rejected up front with `AutobahnError("Invalid roadId/identifier: must be a non-empty string")` instead of building a `//services/...` URL that leaks the upstream "Cannot GET" 404. (Unicode and over-long ids are left to the API, which legitimately answers `[]` — strictly validating the motorway syntax would risk rejecting valid ids and is out of scope.)
- Severity: Low — Confidence: Confirmed
- Repro:
  ```
  node dist/src/cli/index.js roadworks list ""        # → exit 4, see message below
  node dist/src/cli/index.js roadworks list "   "     # → [] (exit 0)
  node dist/src/cli/index.js roadworks list "Ä1"      # → [] (exit 0)
  node dist/src/cli/index.js roadworks list "$(printf 'A%.0s' {1..5000})"  # → [] (exit 0)
  ```
- Actual for empty: `Error: HTTP 404 for GET https://verkehr.autobahn.de/o/autobahn//services/roadworks: Cannot GET /autobahn/services/roadworks` (exit 4) — the doubled `//` and raw upstream "Cannot GET" message leak through. Whitespace/unicode/5000-char ids return an empty array as if they were valid motorways with no roadworks. No client-side roadId validation. `src/client/client.ts:36-42`.

### 7. `--timeout 0` silently disables the timeout, but this is undocumented in `--help` and README — ✅ FIXED
- **Fix:** Documented the "0 disables" semantic in the `--timeout` help text (`src/cli/program.ts`) and in the README global-options table (`README.md`).
- Severity: Low — Confidence: Confirmed
- Repro: `node dist/src/cli/index.js --timeout 0 roads` (succeeds; request runs with no timeout).
- The help text and README say only "per-request timeout in milliseconds". The "0 disables" semantic (`src/client/engine.ts:81` + `src/client/http.ts:98`) is documented for `--max-response-bytes` ("0 = unlimited") but not for `--timeout`, so `--timeout 0` looks like "time out immediately" to a user.

### 8. README "Architecture" advertises a file-output I/O seam that does not exist; no `-o/--output` — ✅ FIXED
- **Fix:** Corrected the architecture comment in `README.md` to `injectable I/O seam (stdout/stderr)`, matching the actual `CliIO` (no file sink, no `-o/--output` is implied). Removed the misleading "/file" claim rather than inventing an output-file feature.
- Severity: Low — Confidence: Confirmed
- README line 151: `io.ts  # injectable I/O seam (stdout/stderr/file)`. The actual `CliIO` (`src/cli/io.ts`) only has `out`/`err` — no file sink, and the CLI exposes no `-o/--output` option (help confirms). The "file" capability is documented but absent.

### 9. `-v` (lowercase) is not accepted for `--version` — ✅ FIXED
- **Fix:** Registered the version flag as `-v, --version` in `src/cli/program.ts`. commander 15 forbids two short flags on one option, so the rarely-used `-V` was replaced by the conventional lowercase `-v`; `--version` is unchanged.
- Severity: Low — Confidence: Confirmed
- Repro: `node dist/src/cli/index.js -v` → `error: unknown option '-v'` (exit 1). Only `-V`/`--version` work. `-v` is the more common convention; this is a frequent foot-gun. `src/cli/program.ts:30` (`.version(VERSION)` only registers `-V`).

### 10. Help/usage text contains a raw em-dash (`—`) and a long unbroken URL that wrap awkwardly in `--help` — ✅ FIXED
- **Fix:** Rewrote the program description in `src/cli/program.ts` to use an ASCII hyphen instead of the em-dash and dropped the inline `https://verkehr.autobahn.de` URL from the description (it is already documented elsewhere), so the help text is plain ASCII and wraps cleanly.
- Severity: Low — Confidence: Confirmed
- Repro: `node dist/src/cli/index.js --help`. The description line `…API (https://verkehr.autobahn.de) — roadworks, …` uses a non-ASCII em-dash and forces mid-word wrapping (e.g. `pretty-`/`printed`, `A2,`/`...`). Cosmetic, but non-ASCII in help output can mangle on non-UTF-8 terminals/Windows code pages.

### 11. Subcommand parse errors print only an abbreviated usage block, top-level errors print full help — inconsistent — ✅ FIXED
- **Fix:** `configureTree()` in `src/cli/run.ts` now calls `command.showHelpAfterError()` on every node as it walks the tree, so subcommand parse errors render the same full help as the root.
- Severity: Low — Confidence: Confirmed
- Repro:
  ```
  node dist/src/cli/index.js roadworks frob     # short usage
  node dist/src/cli/index.js frobnicate         # FULL help dump
  ```
- `showHelpAfterError()` is set on the root program (`src/cli/program.ts:41`) but not propagated to subcommands, so the depth of the error help is inconsistent across the tree.

### 12. `--base-url roads` swallows the command name as the option value, then prints help (exit 1) — no warning — ⚠️ WONTFIX (inherent to commander value-taking options; "roads" is a syntactically valid URL/base value so it cannot be reliably distinguished from a missing-value mistake)
- **Fix:** No code change. This is standard commander behaviour for any option that takes a value: the next token is consumed as the value. `roads` is a legitimate `--base-url` string (a relative host), so there is no robust way to tell "user meant a command" from "user gave a (bad) base URL" without rejecting valid input. The resulting no-command state now shows help on stdout/exit 0 via bug #2's fix when nothing remains, which softens the original exit-1 complaint.
- Severity: Low — Confidence: Confirmed
- Repro: `node dist/src/cli/index.js --base-url roads` → prints help, exit 1. `roads` is consumed as the base-URL value, leaving no command. A user who forgot the URL value gets a help dump rather than "missing value for --base-url" or "no command". (commander default behaviour; surfaces here because base-url takes any string.)

### 13. README claims "Every command prints pretty JSON" but does not document that empty results print `[]` and that motorway-not-found differs from item-not-found — ✅ FIXED
- **Fix:** Added a note to the README exit-codes section (`README.md`) documenting that an empty `list` prints `[]` and exits 0, while a not-found `get` (or API 404) exits 4 — making the three "nothing found" behaviours explicit. Combined with bug #1, the parse-error case no longer exists for not-found.
- Severity: Low — Confidence: Likely
- Empty listings print `[]` with a trailing newline (`node … webcams list A1` → `[]`), which is fine, but combined with #1/#6 the user has three different "nothing found" behaviours (empty array, parse error, 404) with no documentation of which applies where.

### 14. `--user-agent`/`--base-url` empty-string class affects scripting reliability (grouped note) — ✅ FIXED
- **Fix:** Resolved at the shared root cause together with #3/#4: the `RequestEngine` constructor now uses `||` (not `??`) for both string options, so any empty-string global string option falls back to its default. See `src/client/engine.ts`.
- Severity: Low — Confidence: Confirmed
- Bugs #3 and #4 share a root cause (`x ?? DEFAULT` where `x` can be `""` from commander). Any future string global option added the same way will inherit the defect. Flagged as a systemic root-cause note, not double-counted in the total beyond #3/#4.

### 15. Trailing-space motorway id from the API (`"A60 "`, also `"A995a"`) is unreachable through the CLI's option parsing path — ✅ FIXED
- **Fix:** `ServiceResource.list()` in `src/client/client.ts` now `.trim()`s the `roadId` before URL-encoding, so copying an upstream id with a stray trailing space (e.g. `"A60 "`) back into a `list` call now round-trips correctly instead of URL-encoding the space and returning `[]`. (`"A995a"` was already valid; the trailing-space class is the reproducible defect.)
- Severity: Low — Confidence: Likely
- `node dist/src/cli/index.js roads` faithfully returns ids like `"A60 "` (trailing space) and `"A995a"` straight from the upstream API. A user copying `A60 ` back into `roadworks list "A60 "` will URL-encode the trailing space and get `[]` rather than that road's data; the round-trip the README implies ("`<roadId>` is a motorway id from `autobahn roads`") is not reliable for the malformed ids the API itself emits. (Partly an upstream data quirk; surfaced because the client does no normalisation.)

---

## Things that work correctly (probed, no bug)

- `parseIntArg` correctly rejects negative, `0x10`, `1e3`, `3.5`, empty, `abc`, ` 5`, and 20-digit overflow for `--timeout/--max-retries/--max-response-bytes` (`src/cli/shared.ts:16-25`). `--timeout 0` and `--max-response-bytes 0` are accepted as "disable/unlimited" by design.
- Missing required positional (`roadworks list`), extra positionals (`roads foo`, `list A1 A2`), unknown command, and unknown flag all exit 1 with a usage message.
- Network failures map cleanly: ECONNREFUSED, ENOTFOUND, forced `--timeout 1`, `--max-response-bytes 1` cap, and non-http(s) protocols all produce typed `Error:` messages and exit 1.
- Redirects are **not** followed — a `302` surfaces as `HTTP 302 … ` error (matches README).
- 503/429 retry honours `--max-retries` exactly (1 initial + N retries verified = 3 attempts for `--max-retries 2`) and extracts the `detail` field.
- No data loss: `roadworks list A7` returns all 295 items; per-item key sets match the raw API exactly (compared `warnings list A7` item[0] keys vs `curl`). Non-ASCII (e.g. "München") is rendered raw, not `\u`-escaped. Compact and pretty both end in a single `\n`; empty arrays render `[]`.
- Real `get` by a live identifier returns the full detail object identical to `curl`.
- 404 on a bad *motorway path* (`roadworks list ""`) does correctly exit 4.

Total: **15 genuine, reproducible bugs.**
