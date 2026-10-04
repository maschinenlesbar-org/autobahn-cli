// The request engine: turns logical (method, path, query) calls into HTTP
// requests via a Transport, applies retry/backoff for transient statuses
// (429, 502, 503, 504), and decodes responses.

import { MAX_TIMEOUT_MS, nodeHttpTransport, type Transport } from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import {
  AutobahnApiError,
  AutobahnError,
  AutobahnNetworkError,
  AutobahnNotFoundError,
  AutobahnParseError,
  AutobahnValidationError,
  cutForMessage,
  isRetryableStatus,
  redactUrl,
} from "./errors.js";
import { assertValid, baseUrlProblem } from "./validate.js";
import { VERSION } from "./version.js";

export const DEFAULT_BASE_URL = "https://verkehr.autobahn.de";
/**
 * The User-Agent sent unless one is given: name, version and where to find the project,
 * so the API's operator can tell which client and release is calling.
 */
export const DEFAULT_USER_AGENT = `autobahn-cli/${VERSION} (+https://github.com/maschinenlesbar-org/autobahn-cli)`;

export interface RawResponse {
  data: Buffer;
  contentType: string;
  status: number;
}

/**
 * Options for {@link RequestEngine} and the client. The numeric options must be
 * integers within their documented range; anything else (negative, fractional,
 * NaN, Infinity, too large) makes the constructor throw an AutobahnValidationError.
 */
export interface EngineOptions {
  /** Base URL of the API. Defaults to https://verkehr.autobahn.de */
  baseUrl?: string;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport;
  /** Value of the User-Agent header. */
  userAgent?: string;
  /**
   * Per-request timeout in milliseconds (0 disables; at most `MAX_TIMEOUT_MS`, 2^31 - 1 ms).
   * Defaults to 30 000. A request that times out is not retried.
   */
  timeoutMs?: number;
  /** Number of automatic retries for transient (429/502/503/504) responses, 0..`MAX_RETRIES` (10). */
  maxRetries?: number;
  /**
   * Base backoff between retries in milliseconds. Grows linearly per attempt,
   * unless the response carries a `Retry-After` header, which takes precedence.
   * At most 30 000 (the Retry-After ceiling).
   */
  retryDelayMs?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit.
   * At most `Number.MAX_SAFE_INTEGER`.
   */
  maxResponseBytes?: number;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

// Upper bound on how long a Retry-After header may make us wait, so a pathological
// or hostile value (e.g. "Retry-After: 99999999") cannot hang the CLI for hours.
// The retry *count* is bounded by maxRetries, but each individual sleep was not.
const MAX_RETRY_AFTER_MS = 30_000;

/** Shortest wait before retrying a 429 that names no Retry-After. */
const MIN_RATE_LIMIT_DELAY_MS = 1_000;

/**
 * The wait before retry `attempt` of a 429 without Retry-After: from 1 s (or
 * retryDelayMs, if larger), doubling per attempt, at most 30 s. The linear 200/400 ms of
 * the other transient statuses barely backs off from a rate limit, and only adds load to
 * a public service that has just asked for less.
 */
function rateLimitDelay(retryDelayMs: number, attempt: number): number {
  return Math.min(Math.max(retryDelayMs, MIN_RATE_LIMIT_DELAY_MS) * 2 ** (attempt - 1), MAX_RETRY_AFTER_MS);
}

/** Most automatic retries a caller may ask for (the CLI's --max-retries shares it). */
export const MAX_RETRIES = 10;

/**
 * Longest server text (in characters) kept for an error message: an error `detail` or
 * a redirect target. A longer one is cut and ends in "…", so a hostile or buggy body
 * cannot flood stderr or a CI log with one huge line. `AutobahnApiError.body` keeps
 * the full text.
 */
const MAX_DETAIL_LENGTH = 500;

/** Node error codes of a connection that broke off mid-request (`socket hang up` is ECONNRESET). */
const TRANSIENT_NETWORK_CODES = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED"]);

/**
 * True for an AutobahnNetworkError caused by a reset or aborted connection, which the
 * engine retries. A refused connection, a DNS failure or a timeout is not transient in
 * that sense and is not retried.
 */
export function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof AutobahnNetworkError)) return false;
  const code = (err.cause as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code);
}

/** sanitizeServerText, then cut at MAX_DETAIL_LENGTH characters. */
function cleanDetail(text: string): string {
  const clean = sanitizeServerText(text);
  return clean.length > MAX_DETAIL_LENGTH ? `${clean.slice(0, MAX_DETAIL_LENGTH)}…` : clean;
}

/**
 * Why `value` cannot be sent as an HTTP header value, or undefined when it can. Node
 * throws an opaque "Invalid character in header content" at request time for a CR/LF
 * (or any other C0 control or DEL) and for any character above U+00FF; a blank value
 * would send an empty header. Tab is allowed, as in HTTP. Shared by the engine
 * (`userAgent`) and the CLI's `--user-agent` parser. Checked by char code so the
 * source stays free of control bytes.
 */
export function headerValueProblem(value: string): string | undefined {
  if (value.trim() === "") return "Expected a non-empty value.";
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) return "Value contains control characters.";
    if (c > 0xff) return "Value contains characters outside Latin-1 (above U+00FF).";
  }
  return undefined;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * True for the Unicode bidirectional formatting characters: ALM (U+061C), LRM/RLM
 * (U+200E/U+200F), the embeddings and overrides U+202A–U+202E and the isolates
 * U+2066–U+2069. A terminal applies them to the text that follows, so an override
 * in server text can reorder what the user sees ("Trojan Source" spoofing).
 */
export function isBidiControl(code: number): boolean {
  return (
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/** Unicode General Category Cf (format): bidi controls, zero-width characters, U+00AD, U+FEFF, … */
const FORMAT_CHAR = /\p{Cf}/u;

/**
 * A whole terminal escape sequence: a CSI (`ESC [` or the 8-bit U+009B, parameters,
 * intermediates, final byte), a terminated control string (OSC/DCS/SOS/PM/APC, `ESC ]` …
 * up to BEL or ST, or their 8-bit forms) or a short `ESC` sequence. Dropping only the
 * control bytes left the printable rest behind (`ESC ] 0 ; title BEL` became `]0;title`).
 * An unterminated control string is left to the per-character filter, so it cannot
 * swallow the rest of the message. Written with escapes, so the source holds no control
 * bytes.
 */
const ESCAPE_SEQUENCE =
  /(?:\u001b\[|\u009b)[\u0030-\u003f]*[\u0020-\u002f]*[\u0040-\u007e]|(?:\u001b[\]PX^_]|[\u0090\u0098\u009d-\u009f])[^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c)|\u001b[\u0020-\u002f]*[\u0030-\u007e]/g;

/**
 * Make a string that originates in an attacker-controlled response — here the API
 * error `detail` extracted from the response body — safe to print into an error
 * message on stderr:
 *
 * - Whole escape sequences (CSI, OSC and other control strings) are dropped first,
 *   then any remaining C0 and C1 controls and DEL. `JSON.parse` decodes a JSON-escaped ESC
 *   (a backslash-u-001b sequence) into a real ESC byte; printed raw, a hostile or
 *   MITM'd endpoint could drive ANSI/OSC sequences into the terminal (display
 *   spoofing, title changes).
 * - Unicode format characters (General Category Cf) are dropped: the bidi controls
 *   (isBidiControl), so server text cannot reorder the visible message, and the
 *   invisible ones — zero-width space/joiners, word joiner, soft hyphen, BOM — so
 *   two messages that look identical are identical.
 * - Every run of whitespace — newlines, tabs, U+2028/U+2029 included — becomes one
 *   space and the ends are trimmed, so the text stays on one line and a server
 *   cannot forge an `Error:` line of its own.
 *
 * The CLI's JSON output is escaped separately (`escapeControlChars` in
 * cli/shared.ts): `JSON.stringify` alone leaves DEL, C1 and bidi characters raw.
 * Written as a char-code filter so no raw control byte appears in this source.
 */
export function sanitizeServerText(text: string): string {
  let out = "";
  for (const ch of text.replace(ESCAPE_SEQUENCE, "")) {
    const n = ch.codePointAt(0) ?? 0;
    const whitespaceControl = n >= 0x09 && n <= 0x0d;
    if (!whitespaceControl && (n <= 0x1f || (n >= 0x7f && n <= 0x9f) || FORMAT_CHAR.test(ch))) continue;
    out += ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Quote a value for an error message, as `JSON.stringify` does, and also escape what it
 * leaves raw although a terminal acts on it: DEL, the C1 controls and every Unicode
 * format character (bidi overrides, zero-width characters). A road id or identifier is
 * echoed in messages, and it can come from a pipeline; an override in it would reorder
 * the rest of the line ("Trojan Source"). A value longer than MAX_MESSAGE_VALUE_LENGTH
 * characters is cut first (ending in "…"). The result stays valid JSON.
 */
export function quoteValue(value: string): string {
  let out = "";
  for (const ch of JSON.stringify(cutForMessage(value))) {
    const n = ch.codePointAt(0) ?? 0;
    if ((n >= 0x7f && n <= 0x9f) || FORMAT_CHAR.test(ch)) {
      // One escape per UTF-16 unit, so a character above U+FFFF stays valid JSON.
      for (let i = 0; i < ch.length; i++) out += `\\u${ch.charCodeAt(i).toString(16).padStart(4, "0")}`;
    } else {
      out += ch;
    }
  }
  return out;
}

/** An IMF-fixdate (RFC 9110 §5.6.7), the one HTTP-date form senders must generate. */
const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Parse a `Retry-After` header into a delay in milliseconds, supporting both
 * the delta-seconds form (`Retry-After: 120`) and the HTTP-date form
 * (`Retry-After: Wed, 21 Oct 2025 07:28:00 GMT`). Returns `undefined` when the
 * header is absent or unparseable so the caller can fall back to its own backoff.
 *
 * Only an IMF-fixdate reaches `Date.parse`: V8 reads bare numbers such as "1.5" or
 * "-5" as dates in 2001, which would turn a malformed header into a 0 ms delay — an
 * instant retry against a server that asked us to slow down.
 */
export function parseRetryAfter(value: string | string[] | undefined): number | undefined {
  const raw = (Array.isArray(value) ? value[0] : value)?.trim();
  if (!raw) return undefined;

  if (/^\d+$/.test(raw)) {
    return Number(raw) * 1000;
  }

  if (!IMF_FIXDATE.test(raw)) return undefined;
  const when = Date.parse(raw);
  if (Number.isNaN(when)) return undefined;
  return Math.max(0, when - Date.now());
}

/**
 * Read a numeric engine option: `undefined` gives the default; anything but an
 * integer in [0, max] throws. Without this a negative or NaN `timeoutMs` silently
 * disabled the timeout, and `maxResponseBytes: -1` the size cap.
 */
function intOption(name: string, value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new AutobahnValidationError(
      `Invalid option ${name}: expected an integer from 0 to ${max}, got ${String(value)}.`,
    );
  }
  return value;
}

export class RequestEngine {
  private readonly baseUrl: string;
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: EngineOptions = {}) {
    // Only `undefined` selects a default (`??`, not `||`): a blank baseUrl or
    // userAgent is rejected like "  ", as the CLI rejects `--base-url ""`. Both are
    // configuration errors, so AutobahnValidationError (an AutobahnError), not
    // AutobahnNetworkError, which a caller may treat as "retry later".
    // The base URL is checked raw, before the trailing slashes are stripped. The
    // default transport re-checks the scheme per hop; a custom transport may not.
    const baseUrl = assertValid("option baseUrl", options.baseUrl ?? DEFAULT_BASE_URL, baseUrlProblem);
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.transport = options.transport ?? nodeHttpTransport;
    // Checked here, not first by Node at request time (as an AutobahnNetworkError).
    this.userAgent = assertValid("option userAgent", options.userAgent ?? DEFAULT_USER_AGENT, headerValueProblem);
    this.timeoutMs = intOption("timeoutMs", options.timeoutMs, 30_000, MAX_TIMEOUT_MS);
    this.maxRetries = intOption("maxRetries", options.maxRetries, 2, MAX_RETRIES);
    this.retryDelayMs = intOption("retryDelayMs", options.retryDelayMs, 200, MAX_RETRY_AFTER_MS);
    this.maxResponseBytes = intOption(
      "maxResponseBytes",
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      Number.MAX_SAFE_INTEGER,
    );
    this.sleep = options.sleep ?? realSleep;
  }

  /**
   * Build a fully-qualified URL from a path and optional query parameters.
   *
   * Throws an AutobahnValidationError for a path with a "." or ".." segment. The client puts
   * road ids and identifiers into the path with `encodeURIComponent`, which leaves
   * those two unchanged, and URL parsing then resolves them: `roadworks list ..`
   * would request `/o/services/roadworks` and report "no roadworks" with exit 0.
   * Neither can name a resource. (Percent-encoded forms such as "%2e%2e" are safe:
   * encodeURIComponent turns their "%" into "%25".) The client rejects such ids first,
   * with a message about the id (validate.ts `idProblem`); this guard is the backstop for
   * a direct `getJson`/`request` caller.
   */
  buildUrl(path: string, query?: QueryParams): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const dotSegment = normalizedPath.split("/").find((s) => s === "." || s === "..");
    if (dotSegment !== undefined) {
      throw new AutobahnValidationError(
        `Invalid path segment "${dotSegment}" in ${normalizedPath}: "." and ".." cannot be used as an id.`,
      );
    }
    const qs = query ? buildQueryString(query) : "";
    return `${this.baseUrl}${normalizedPath}${qs ? `?${qs}` : ""}`;
  }

  /**
   * The request URL as error messages show it: absolute (so a message names the host
   * that gave a bad answer, which matters with a custom base URL), userinfo redacted
   * and cut at MAX_MESSAGE_VALUE_LENGTH characters.
   */
  describeUrl(path: string, query?: QueryParams): string {
    return cutForMessage(redactUrl(this.buildUrl(path, query)));
  }

  /** Perform a request with Accept negotiation and transient-error retries. */
  async request(
    method: string,
    path: string,
    options: { query?: QueryParams; accept: string } = { accept: "application/json" },
  ): Promise<RawResponse> {
    const url = this.buildUrl(path, options.query);
    const headers: Record<string, string> = {
      Accept: options.accept,
      "User-Agent": this.userAgent,
    };

    let attempt = 0;
    // attempts = initial try + maxRetries
    for (;;) {
      let response: Awaited<ReturnType<Transport>>;
      try {
        response = await this.transport({
          method,
          url,
          headers,
          timeoutMs: this.timeoutMs,
          ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
        });
      } catch (cause) {
        // A connection the server (or a gateway) reset is the network-level twin of a
        // 502: retry the GET like a transient status. Timeouts are not retried — a slow
        // upstream should not be asked again at once, and --timeout bounds each attempt.
        if (isTransientNetworkError(cause) && attempt < this.maxRetries) {
          attempt += 1;
          await this.sleep(this.retryDelayMs * attempt);
          continue;
        }
        // The default transport rejects with AutobahnNetworkError only; an injected one
        // may throw anything. Keep the library's error contract for both: a caller (and
        // the CLI) can rely on every failure being an AutobahnError. A network error is
        // re-raised naming the request (Node's text — "socket hang up" — says nothing
        // about which host failed), with the original as `cause`; any other
        // AutobahnError passes through.
        if (cause instanceof AutobahnError && !(cause instanceof AutobahnNetworkError)) throw cause;
        const reason = cause instanceof Error ? cause.message : String(cause);
        const retried = attempt > 0 ? ` (after ${attempt} ${attempt === 1 ? "retry" : "retries"})` : "";
        throw new AutobahnNetworkError(
          `${method} ${this.describeUrl(path, options.query)} failed: ${sanitizeServerText(reason)}${retried}`,
          { cause },
        );
      }

      const status = response.status;
      if (isRetryableStatus(status) && attempt < this.maxRetries) {
        attempt += 1;
        // Honour a Retry-After header when present, clamped to MAX_RETRY_AFTER_MS
        // so a pathological/hostile value can't hang the CLI; otherwise fall back
        // to linear backoff.
        const retryAfter = parseRetryAfter(response.headers["retry-after"]);
        const delay =
          retryAfter !== undefined
            ? Math.min(retryAfter, MAX_RETRY_AFTER_MS)
            : status === 429
              ? rateLimitDelay(this.retryDelayMs, attempt)
              : this.retryDelayMs * attempt;
        await this.sleep(delay);
        continue;
      }

      const contentType = String(response.headers["content-type"] ?? "");
      if (status < 200 || status >= 300) {
        throw this.toApiError(method, url, status, response.body, response.headers["location"], attempt);
      }

      return { data: response.body, contentType, status };
    }
  }

  /**
   * Perform a GET expecting JSON and parse it into `T`. An empty (or whitespace-only)
   * body is an AutobahnParseError, or with `emptyIsNotFound` an AutobahnNotFoundError
   * that names the status the server really sent.
   */
  async getJson<T>(
    path: string,
    query?: QueryParams,
    options: { emptyIsNotFound?: boolean } = {},
  ): Promise<T> {
    const res = await this.request("GET", path, { query, accept: "application/json" });
    const text = decodeBody(res.data, res.contentType, this.describeUrl(path, query));
    if (text.trim() === "") {
      // Only the detail endpoint answers an unknown identifier with HTTP 200 and an
      // *empty* body rather than a 404, so only there (emptyIsNotFound) does an empty
      // body mean "not found" (AutobahnNotFoundError, exit 4). It is not reported as an
      // HTTP 404: the server sent a 2xx, and the message says which. Elsewhere — the
      // road list, a service listing — it is a broken response, not a missing resource.
      if (!options.emptyIsNotFound) {
        throw new AutobahnParseError(`Empty response body from ${this.describeUrl(path, query)}`);
      }
      throw new AutobahnNotFoundError(
        `Not found: the API answered HTTP ${res.status} with an empty body for GET ` +
          this.describeUrl(path, query),
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      // An HTML maintenance or proxy page is the usual non-JSON answer: name its type,
      // so it reads as an upstream problem rather than a client bug.
      const type = res.contentType.split(";")[0]?.trim() ?? "";
      const hint = type !== "" && !/json/i.test(type) ? `: expected JSON, got Content-Type "${cleanDetail(type)}"` : "";
      throw new AutobahnParseError(`Failed to parse JSON response from ${this.describeUrl(path, query)}${hint}`, {
        cause,
      });
    }
  }

  private toApiError(
    method: string,
    url: string,
    status: number,
    body: Buffer,
    locationHeader?: string,
    retries = 0,
  ): AutobahnApiError {
    const text = body.toString("utf8");
    let detail: string | undefined;
    try {
      const parsed = JSON.parse(text) as { detail?: unknown; message?: unknown };
      if (parsed && typeof parsed.detail === "string") detail = parsed.detail;
      else if (parsed && typeof parsed.message === "string") detail = parsed.message;
    } catch {
      // Non-JSON error body; leave detail undefined.
    }
    // `detail` came from the response body; strip control characters so a hostile
    // endpoint cannot inject terminal escape sequences via the stderr error message,
    // and cap its length.
    if (detail !== undefined) detail = cleanDetail(detail);
    // Redirects are not followed; name the target so the user can fix --base-url.
    const location =
      status >= 300 && status < 400 && locationHeader ? redirectTarget(url, locationHeader) : undefined;
    return new AutobahnApiError({ status, url, method, body: text, detail, location, retries });
  }
}

/**
 * Decode a response body by the charset its Content-Type names (UTF-8 when it names
 * none). TextDecoder drops a leading byte order mark, which Buffer#toString keeps and
 * JSON.parse then rejects, so a BOM added by a proxy or a backend change cannot turn
 * a valid answer into a parse error. An unknown charset label is an
 * AutobahnParseError.
 */
function decodeBody(body: Buffer, contentType: string, url: string): string {
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType)?.[1] ?? "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    throw new AutobahnParseError(`Unsupported response charset "${sanitizeServerText(charset)}" from ${url}.`);
  }
  return decoder.decode(body);
}

/**
 * The absolute, printable form of a `Location` header: resolved against the request
 * URL, userinfo redacted, control/bidi characters stripped (it is server text bound
 * for stderr). An unparseable value is shown sanitised as it came.
 */
function redirectTarget(requestUrl: string, location: string): string | undefined {
  let target: string;
  try {
    target = redactUrl(new URL(location, requestUrl).href);
  } catch {
    target = location;
  }
  const clean = cleanDetail(target);
  return clean === "" ? undefined : clean;
}
