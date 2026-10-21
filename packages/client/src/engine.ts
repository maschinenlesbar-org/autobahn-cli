// The request engine: turns logical (method, path, query) calls into HTTP
// requests via a Transport, applies retry/backoff for transient statuses
// (429, 502, 503, 504), and decodes responses.

import { TextDecoder } from "node:util";
import { MAX_TIMEOUT_MS, nodeHttpTransport, sizeLimitMessage, type HttpRequest, type HttpResponse, type Transport } from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import {
  AutobahnApiError,
  AutobahnError,
  AutobahnNetworkError,
  AutobahnNotFoundError,
  AutobahnParseError,
  AutobahnValidationError,
  credentialsIn,
  cutForMessage,
  cutText,
  echoedCredentialForms,
  isRedirectStatus,
  isRetryableStatus,
  redactCredentials,
  redactSecrets,
  quoteValue,
  redactUrl,
} from "./errors.js";
import { assertValid, baseUrlProblem } from "./validate.js";

// quoteValue lives with the other message helpers (validate.ts quotes refused values with it).
export { quoteValue } from "./errors.js";

export const DEFAULT_BASE_URL = "https://verkehr.autobahn.de";
/**
 * The User-Agent sent unless one is given: the project and where to find it. The client
 * has no release version of its own; the CLI sends its name, version and URL instead
 * (apps/cli, `USER_AGENT`), so the API's operator can tell which release is calling.
 */
export const DEFAULT_USER_AGENT: string = "autobahn-cli (+https://github.com/maschinenlesbar-org/autobahn-cli)";

export interface RawResponse {
  data: Buffer;
  contentType: string;
  /** The Content-Encoding header ("" when absent). */
  contentEncoding: string;
  status: number;
}

/**
 * Options for {@link RequestEngine} and the client. The numeric options must be
 * integers within their documented range; anything else (negative, fractional,
 * NaN, Infinity, too large) makes the constructor throw an AutobahnValidationError.
 */
export interface EngineOptions {
  /** Base URL of the API. Defaults to https://verkehr.autobahn.de */
  baseUrl?: string | undefined;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport | undefined;
  /** Value of the User-Agent header. */
  userAgent?: string | undefined;
  /**
   * Per-request timeout in milliseconds (0 disables; at most `MAX_TIMEOUT_MS`, 2^31 - 1 ms).
   * Defaults to 30 000. A request that times out is not retried.
   */
  timeoutMs?: number | undefined;
  /**
   * Number of automatic retries for transient 429/502/503/504 responses and reset
   * connections (`isTransientNetworkError`), 0..`MAX_RETRIES` (10); defaults to 2.
   * Timeouts are not retried.
   */
  maxRetries?: number | undefined;
  /**
   * Base backoff between retries in milliseconds (default 200). Grows linearly per
   * attempt for 502/503/504 and reset connections. A 429 waits at least 1 s, doubling
   * per attempt (from this value when larger), at most 30 s. A `Retry-After` header
   * takes precedence over both. At most 30 000 (the Retry-After ceiling).
   */
  retryDelayMs?: number | undefined;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit.
   * At most `Number.MAX_SAFE_INTEGER`.
   */
  maxResponseBytes?: number | undefined;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /**
   * Called once per retry, right before the backoff sleep, for each retried status
   * and reset connection; never when there is no retry. A throw is swallowed.
   */
  onRetry?: ((event: RetryEvent) => void) | undefined;
  /**
   * Called with a one-line warning about an answer the engine delivered changed: characters
   * that were not valid text — invalid bytes in the declared (or default UTF-8) charset, or a
   * lone surrogate written as a JSON escape — replaced with U+FFFD. The message names the
   * request and the count (`GET <url>: 2 characters of the answer were not valid text …`).
   * Without it the replacement is silent. A throw is swallowed. The CLI logs it as a `WARN`
   * record of `autobahn.api`.
   */
  onWarning?: ((message: string) => void) | undefined;
  /**
   * Member names whose number values may exceed 2^53 (a Solr `_version_`, a 64-bit id). The value
   * of a declared member is delivered as its exact literal, as written, as a JSON string (`"5"`),
   * so its type never depends on its size. A declared member whose value is not a number (a
   * string, `null`, an object) is left as it is. Every undeclared number keeps the rule: exact,
   * or an AutobahnParseError. Matched by name anywhere in a JSON answer, an escaped
   * name (`"\u005fversion_"`) included. Defaults to none; anything but a set or list of
   * non-empty strings makes the constructor throw an AutobahnValidationError. The set is copied.
   */
  bigIntegerKeys?: ReadonlySet<string> | undefined;
}

/** What `EngineOptions.onRetry` is told about one retry. */
export interface RetryEvent {
  /** Which retry this is, counting from 1. */
  retry: number;
  /** The most retries this request may make (`maxRetries`). */
  maxRetries: number;
  /** How long the engine waits before sending the request again. */
  delayMs: number;
  /** The HTTP status that caused the retry; absent for a reset connection. */
  status?: number;
  /** The URL being retried, userinfo redacted. */
  url: string;
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

/** Why `value` is not a usable HttpResponse, or undefined when it is. */
function responseProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "not an object";
  const r = value as Partial<Record<"status" | "headers" | "body", unknown>>;
  if (typeof r.status !== "number" || !Number.isInteger(r.status) || r.status < 100 || r.status > 599) {
    return "status is not an HTTP status code";
  }
  if (typeof r.headers !== "object" || r.headers === null || Array.isArray(r.headers)) return "headers is not an object";
  if (bodyBytes(r.body) === undefined) return "body is not a Buffer, Uint8Array, other ArrayBuffer view or ArrayBuffer";
  return undefined;
}

/**
 * The response body as a Buffer (a view, no copy): a Buffer, any ArrayBuffer view (a
 * Uint8Array from fetch, a DataView) or an ArrayBuffer/SharedArrayBuffer — checked by internal
 * slot, not `instanceof`, so a value from another realm (a vm context, a Jest test) counts.
 * Undefined for anything else.
 */
function bodyBytes(value: unknown): Buffer | undefined {
  if (Buffer.isBuffer(value)) return value;
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const tag = Object.prototype.toString.call(value);
  if (tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]") return Buffer.from(value as ArrayBuffer);
  return undefined;
}

/**
 * The response headers as a plain record. A transport built on `fetch` naturally returns
 * its `Headers` object, which passes as an object but has no plain properties: the
 * engine then saw no Retry-After and no Content-Type at all. Such an object (anything
 * with `get` and `forEach`) is copied into a record; a plain record gets its names
 * lower-cased, as the engine reads them.
 */
function plainHeaders(headers: object): Record<string, string | string[] | undefined> {
  const h = headers as { get?: unknown; forEach?: unknown };
  // Records built from an answer have no prototype: a header named `__proto__` is an own
  // entry like any other, never the record's prototype (whose entries would read as headers).
  if (typeof h.get === "function" && typeof h.forEach === "function") {
    const record: Record<string, string> = Object.create(null) as Record<string, string>;
    (h.forEach as (cb: (value: string, name: string) => void) => void).call(headers, (value, name) => {
      record[name.toLowerCase()] = value;
    });
    return record;
  }
  // Node's transport lower-cases header names; a custom one may not ("Content-Type").
  const record = Object.create(null) as Record<string, string | string[] | undefined>;
  for (const [name, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    record[name.toLowerCase()] = value;
  }
  return record;
}

/**
 * Error codes of a connection that broke off mid-request: Node's (`socket hang up` is
 * ECONNRESET) and undici's (`fetch failed` with cause UND_ERR_SOCKET, "other side closed").
 */
const TRANSIENT_NETWORK_CODES = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED", "UND_ERR_SOCKET"]);

/** True when `err` or an error in its `cause` chain has a transient connection code. */
function hasTransientCode(err: unknown, depth = 0): boolean {
  if (typeof err !== "object" || err === null || depth > 4) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) return true;
  return hasTransientCode((err as { cause?: unknown }).cause, depth + 1);
}

/**
 * True for an AutobahnNetworkError caused by a reset or aborted connection, which the
 * engine retries — whichever transport raised it (a Node error, fetch's TypeError with an
 * undici cause). A refused connection, a DNS failure or a timeout is not transient in
 * that sense and is not retried.
 */
export function isTransientNetworkError(err: unknown): boolean {
  return err instanceof AutobahnNetworkError && hasTransientCode(err.cause);
}

/** sanitizeServerText, then cut at MAX_DETAIL_LENGTH characters (never inside a surrogate pair). */
function cleanDetail(text: string): string {
  const clean = sanitizeServerText(text);
  return clean.length > MAX_DETAIL_LENGTH ? `${cutText(clean, MAX_DETAIL_LENGTH)}…` : clean;
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
  // A JavaScript caller may pass anything; `{}.trim()` was a raw TypeError.
  if (typeof value !== "string") return "Expected a string.";
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

/** True for a loopback host: `localhost`, 127.0.0.0/8 or `::1` (as URL#hostname spells it). */
function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * Whether requests to `baseUrl` would travel unencrypted, as one sentence for a warning,
 * or `undefined` when they would not: for `https:`, for a
 * URL that does not parse, and for a loopback host (`localhost`, 127.0.0.0/8, `::1`),
 * where nothing leaves the machine.
 *
 * The sentence names the host (`url.host`: host and port, never the userinfo) and what
 * secret travels with the requests: the base URL's credentials when it carries userinfo,
 * and every phrase in `secrets` (noun phrases such as "the API key"). It never contains
 * a password or key. The CLI logs it as a `WARN` record of `autobahn.http` on stderr
 * (once per run, before the first request).
 */
export function cleartextProblem(baseUrl: string, secrets: readonly string[] = []): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" || isLoopbackHost(url.hostname)) return undefined;
  const userinfo = url.username !== "" || url.password !== "";
  const phrases = [...secrets, ...(userinfo ? ["the base URL's credentials"] : [])];
  if (phrases.length === 0) return `requests to ${url.host} are sent unencrypted (http:, not https:)`;
  const verb = phrases.length === 1 && !userinfo ? "is" : "are";
  return `${phrases.join(" and ")} ${verb} sent unencrypted to ${url.host} (http:, not https:)`;
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

/** Every EngineOptions key. */
const OPTION_NAMES = [
  "baseUrl",
  "transport",
  "userAgent",
  "timeoutMs",
  "maxRetries",
  "retryDelayMs",
  "maxResponseBytes",
  "sleep",
  "onRetry",
  "onWarning",
  "bigIntegerKeys",
] as const satisfies ReadonlyArray<keyof EngineOptions>;

/**
 * Throw for a key that is not an EngineOptions name. A JavaScript caller's typo
 * (`timeout` for `timeoutMs`) was ignored silently and the default applied; TypeScript
 * catches it at compile time, JavaScript does not.
 */
function assertKnownOptions(options: object): void {
  for (const [key, value] of Object.entries(options)) {
    // An unset key (`proxy: undefined` from a spread config) changes nothing: skip it.
    if (value === undefined || (OPTION_NAMES as readonly string[]).includes(key)) continue;
    const lower = key.toLowerCase();
    const hint = OPTION_NAMES.find((name) => name.toLowerCase().includes(lower) || lower.includes(name.toLowerCase()));
    throw new AutobahnValidationError(
      `Unknown option ${quoteValue(key)}` +
        (hint === undefined ? `; the options are ${OPTION_NAMES.join(", ")}.` : ` (did you mean ${hint}?).`),
    );
  }
}

/** No declared big-integer members (`EngineOptions.bigIntegerKeys` left out). */
const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * Read the `bigIntegerKeys` option: `undefined` gives none; a set or list of non-empty strings is
 * copied; anything else throws an AutobahnValidationError.
 */
export function bigIntegerKeysOption(value: ReadonlySet<string> | undefined): ReadonlySet<string> {
  if (value === undefined) return NO_KEYS;
  const iterable = typeof value === "object" && value !== null && typeof (value as Iterable<unknown>)[Symbol.iterator] === "function";
  const names = iterable ? [...(value as Iterable<unknown>)] : [];
  if (!iterable || names.some((key) => typeof key !== "string" || key === "")) {
    throw new AutobahnValidationError("Invalid option bigIntegerKeys: expected a set of non-empty member names.");
  }
  return new Set(names as string[]);
}

/**
 * Read a function option: `undefined` gives the default; anything else that is not a
 * function throws. A string `transport` used to fail at the first request as a network
 * error, and a bad `sleep` as a raw TypeError on the first retry.
 */
function functionOption<F extends (...args: never[]) => unknown>(name: string, value: F | undefined, fallback: F): F {
  if (value === undefined) return fallback;
  if (typeof value !== "function") {
    throw new AutobahnValidationError(`Invalid option ${name}: expected a function, got ${typeof value}.`);
  }
  return value;
}

export class RequestEngine {
  // A real private field (not TypeScript's `private`): util.inspect, console.log and
  // JSON.stringify of a client never show it, so a password in the base URL can't be
  // logged by accident. Messages use describeUrl, which redacts it.
  readonly #baseUrl: string;
  /** The base URL's userinfo, raw and percent-decoded, for scrubbing server and transport text. */
  readonly #credentials: string[];
  /**
   * The forms a server echoes that userinfo back in (the Basic value, the decoded
   * `user:password`, the password alone; `echoedCredentialForms`), longest first.
   */
  readonly #echoed: string[];
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onWarning: ((message: string) => void) | undefined;
  /** `EngineOptions.bigIntegerKeys`, copied. */
  readonly bigIntegerKeys: ReadonlySet<string>;
  private readonly onRetry: ((event: RetryEvent) => void) | undefined;

  constructor(options: EngineOptions = {}) {
    // A JavaScript caller may pass null for "no options"; treat it like undefined.
    options = options ?? {};
    assertKnownOptions(options);
    // Only `undefined` selects a default (`??`, not `||`): a blank baseUrl or
    // userAgent is rejected like "  ", as the CLI rejects `--base-url ""`. Both are
    // configuration errors, so AutobahnValidationError (an AutobahnError), not
    // AutobahnNetworkError, which a caller may treat as "retry later".
    // The base URL is checked raw, before the trailing slashes are stripped. The
    // default transport re-checks the scheme per hop; a custom transport may not.
    const baseUrl = assertValid("option baseUrl", options.baseUrl ?? DEFAULT_BASE_URL, baseUrlProblem);
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
    this.#credentials = credentialsIn(baseUrl).flatMap((raw) => {
      try {
        return [raw, decodeURIComponent(raw)];
      } catch {
        return [raw];
      }
    });
    // Longest first, so a password never leaves half of the user:password around it.
    this.#echoed = credentialsIn(baseUrl).flatMap(echoedCredentialForms).sort((a, b) => b.length - a.length);
    this.transport = functionOption("transport", options.transport, nodeHttpTransport);
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
    this.sleep = functionOption("sleep", options.sleep, realSleep);
    this.onRetry =
      options.onRetry === undefined ? undefined : functionOption("onRetry", options.onRetry, () => {});
    this.onWarning =
      options.onWarning === undefined ? undefined : functionOption("onWarning", options.onWarning, () => {});
    this.bigIntegerKeys = bigIntegerKeysOption(options.bigIntegerKeys);
  }

  /** Tell `onWarning` about an answer delivered changed. A throwing callback never breaks the request. */
  private warn(message: string): void {
    try {
      this.onWarning?.(message);
    } catch {
      // a logging hook is no reason to fail the request
    }
  }

  /** Tell `onRetry` about a retry, then wait. A throwing callback never breaks the request. */
  private async backOff(attempt: number, delayMs: number, url: string, status?: number): Promise<void> {
    try {
      this.onRetry?.({
        retry: attempt,
        maxRetries: this.maxRetries,
        delayMs,
        ...(status !== undefined ? { status } : {}),
        url: redactUrl(url),
      });
    } catch {
      // a logging hook is no reason to fail the request
    }
    await this.sleep(delayMs);
  }

  /**
   * `text` without the base URL's credentials: server text (an error body that echoes the
   * request URL, or the Authorization header and the decoded `user:password`) and
   * transport text (fetch's "Failed to fetch <url>") can carry them.
   */
  private scrub(text: string): string {
    return this.#credentials.length === 0 ? text : redactSecrets(redactCredentials(text, this.#credentials), this.#echoed);
  }

  /**
   * A transport failure as the `cause` of the error the engine raises: the original when its
   * text carries no credentials, otherwise a copy with them scrubbed (message, `code` and the
   * cause chain kept), so logging the error with its causes can't reveal the base URL's
   * password.
   */
  private scrubCause(cause: unknown, depth = 0): unknown {
    if (this.#credentials.length === 0 || depth > 5) return cause;
    if (typeof cause === "string") return this.scrub(cause);
    if (!(cause instanceof Error)) return cause;
    const inner = this.scrubCause(cause.cause, depth + 1);
    const message = this.scrub(cause.message);
    if (message === cause.message && inner === cause.cause && !this.scrub(cause.stack ?? "").includes("***@")) return cause;
    const copy = new Error(message, inner === undefined ? undefined : { cause: inner });
    copy.name = cause.name;
    const code = (cause as { code?: unknown }).code;
    if (code !== undefined) Object.assign(copy, { code });
    return copy;
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
    return this.joinUrl(normalizedPath, query);
  }

  /** Base URL + path + query string, without buildUrl's validation. */
  private joinUrl(path: string, query?: QueryParams): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const qs = query ? buildQueryString(query) : "";
    return `${this.#baseUrl}${normalizedPath}${qs ? `?${qs}` : ""}`;
  }

  /**
   * The request URL as error messages show it: absolute (so a message names the host
   * that gave a bad answer, which matters with a custom base URL), userinfo redacted
   * and cut at MAX_MESSAGE_VALUE_LENGTH characters. It never throws: describing a URL
   * for a message or a log line does not validate it (buildUrl does).
   */
  describeUrl(path: string, query?: QueryParams): string {
    return cutForMessage(redactUrl(this.joinUrl(path, query)));
  }

  /**
   * Call the transport under the overall deadline (`timeoutMs`): the request gets an
   * AbortSignal that fires at the deadline, and the call rejects then whether the transport
   * stops or not — a custom transport (fetch, a node:http wrapper) that ignores `timeoutMs`
   * can't hang the caller. A synchronous throw becomes a rejection.
   */
  private async callTransport(request: HttpRequest): Promise<HttpResponse> {
    const call = (signal?: AbortSignal): Promise<HttpResponse> =>
      Promise.resolve().then(() => this.transport(signal === undefined ? request : { ...request, signal }));
    if (this.timeoutMs === 0) return call();
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new AutobahnNetworkError(`Request exceeded overall deadline of ${this.timeoutMs}ms`);
        controller.abort(err);
        reject(err);
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([call(controller.signal), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Perform a request with Accept negotiation and transient-error retries. */
  async request(
    method: string,
    path: string,
    options: { query?: QueryParams | undefined; accept: string } = { accept: "application/json" },
  ): Promise<RawResponse> {
    const url = this.buildUrl(path, options.query);
    const headers: Record<string, string> = {
      Accept: options.accept,
      "User-Agent": this.userAgent,
    };

    // Only an idempotent request is sent again: request() is public, and a POST re-sent
    // after a reset or a 503 may be applied twice. The client itself sends GETs only.
    const idempotent = /^(GET|HEAD)$/i.test(method);
    let attempt = 0;
    // attempts = initial try + maxRetries
    for (;;) {
      let response: Awaited<ReturnType<Transport>>;
      try {
        response = await this.callTransport({
          method,
          url,
          headers,
          timeoutMs: this.timeoutMs,
          ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
        });
      } catch (cause) {
        // A connection the server (or a gateway) reset is the network-level twin of a
        // 502: retry the GET like a transient status, whichever transport reported it.
        // Timeouts are not retried — a slow upstream should not be asked again at once,
        // and --timeout bounds each attempt.
        if (idempotent && hasTransientCode(cause) && attempt < this.maxRetries) {
          attempt += 1;
          await this.backOff(attempt, this.retryDelayMs * attempt, url);
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
          `${method} ${this.describeUrl(path, options.query)} failed: ${sanitizeServerText(this.scrub(reason))}${retried}`,
          { cause: this.scrubCause(cause) },
        );
      }

      // An injected transport may resolve with anything; a malformed HttpResponse would
      // otherwise surface below as a raw TypeError, outside the AutobahnError contract.
      const invalid = responseProblem(response);
      if (invalid !== undefined) {
        throw new AutobahnNetworkError(
          `${method} ${this.describeUrl(path, options.query)} failed: the transport returned an invalid response (${invalid}).`,
        );
      }
      const status = response.status;
      const responseHeaders = plainHeaders(response.headers);
      // fetch gives a Uint8Array; view it as a Buffer (no copy), which the decoders expect.
      // (HttpResponse types the body as Buffer; a JavaScript transport may not.)
      const body = bodyBytes(response.body) as Buffer;
      // The size cap holds whatever the transport did: the default one aborts early, a custom
      // one may have read everything.
      if (this.maxResponseBytes > 0 && body.byteLength > this.maxResponseBytes) {
        throw new AutobahnNetworkError(
          `${method} ${this.describeUrl(path, options.query)} failed: ${sizeLimitMessage(this.maxResponseBytes)}`,
        );
      }
      if (idempotent && isRetryableStatus(status) && attempt < this.maxRetries) {
        attempt += 1;
        // Back off: doubling from 1 s for a 429, linear from retryDelayMs for 502/503/504.
        // A Retry-After header can ask for longer (clamped to MAX_RETRY_AFTER_MS so a
        // pathological value can't hang the CLI), never for less: `Retry-After: 0` or a date
        // in the past turned the retries into a zero-delay burst against a server that had
        // just asked for less load.
        const backoff = status === 429 ? rateLimitDelay(this.retryDelayMs, attempt) : this.retryDelayMs * attempt;
        const retryAfter = parseRetryAfter(responseHeaders["retry-after"]);
        const delay = retryAfter === undefined ? backoff : Math.min(Math.max(retryAfter, backoff), MAX_RETRY_AFTER_MS);
        await this.backOff(attempt, delay, url, status);
        continue;
      }

      const contentType = String(responseHeaders["content-type"] ?? "");
      if (status < 200 || status >= 300) {
        const location = responseHeaders["location"];
        throw this.toApiError(method, url, status, body, typeof location === "string" ? location : undefined, attempt);
      }

      const contentEncoding = String(responseHeaders["content-encoding"] ?? "").trim();
      return { data: body, contentType, contentEncoding, status };
    }
  }

  /**
   * Perform a GET expecting JSON and parse it into `T`. An empty (or whitespace-only)
   * body is an AutobahnParseError, or with `emptyIsNotFound` an AutobahnNotFoundError
   * that names the status the server really sent. Every error about the answer names the
   * request (`GET <url>: …`, userinfo redacted).
   *
   * The text is never changed silently: bytes that are not valid in the charset, and lone
   * surrogates written as JSON escapes (`\ud800`), are replaced with U+FFFD, so the result is
   * well-formed text (`jq` rejects a lone surrogate, and with it the whole output), and
   * `onWarning` is told how many. One bad character never sinks a whole answer.
   */
  async getJson<T>(
    path: string,
    query?: QueryParams,
    options: { emptyIsNotFound?: boolean | undefined } = {},
  ): Promise<T> {
    const res = await this.request("GET", path, { query, accept: "application/json" });
    const request = `GET ${this.describeUrl(path, query)}`;
    // The client sends no Accept-Encoding and does not decompress; a compressed body can
    // only come from a misbehaving proxy. Name it rather than fail as "not JSON".
    // A list of codings is allowed (RFC 9110 §8.4); only `identity` ones mean "not encoded".
    const codings = res.contentEncoding.split(",").map((c) => c.trim()).filter((c) => c !== "");
    if (codings.some((c) => !/^identity$/i.test(c))) {
      throw new AutobahnParseError(
        `${request}: unsupported Content-Encoding "${cleanDetail(res.contentEncoding)}" (the client does not decompress responses).`,
      );
    }
    const decoded = decodeBody(res.data, res.contentType, request);
    if (decoded.text.trim() === "") {
      // Only the detail endpoint answers an unknown identifier with HTTP 200 and an
      // *empty* body rather than a 404, so only there (emptyIsNotFound) does an empty
      // body mean "not found" (AutobahnNotFoundError, exit 4). It is not reported as an
      // HTTP 404: the server sent a 2xx, and the message says which. Elsewhere — the
      // road list, a service listing — it is a broken response, not a missing resource.
      if (!options.emptyIsNotFound) {
        throw new AutobahnParseError(`${request}: empty response body.`);
      }
      throw new AutobahnNotFoundError(
        `Not found: the API answered HTTP ${res.status} with an empty body for GET ` +
          this.describeUrl(path, query),
      );
    }
    const repaired = wellFormedEscapes(decoded.text);
    // Declared big integers are quoted first, so JSON.parse delivers them exactly.
    const { json, inexact } = scanNumbers(repaired.json, this.bigIntegerKeys);
    let parsed: T;
    try {
      parsed = JSON.parse(json) as T;
    } catch (cause) {
      // An HTML maintenance or proxy page is the usual non-JSON answer: name its type,
      // so it reads as an upstream problem rather than a client bug.
      const type = res.contentType.split(";")[0]?.trim() ?? "";
      const hint = type !== "" && !/json/i.test(type) ? ` (expected JSON, got Content-Type "${cleanDetail(type)}")` : "";
      throw new AutobahnParseError(`${request}: the answer is not valid JSON${hint}.`, { cause });
    }
    // JSON.parse rounds and overflows numbers silently: refuse the answer rather than print a
    // changed value.
    if (inexact !== undefined) {
      throw new AutobahnParseError(`${request}: the number ${cutForMessage(inexact)} cannot be represented exactly.`);
    }
    const replaced = decoded.replaced + repaired.replaced;
    if (replaced > 0) {
      this.warn(
        `${request}: ${replaced} ${replaced === 1 ? "character" : "characters"} of the answer ${replaced === 1 ? "was" : "were"} ` +
          "not valid text (invalid bytes or a lone surrogate) and replaced with U+FFFD.",
      );
    }
    return parsed;
  }

  private toApiError(
    method: string,
    url: string,
    status: number,
    body: Buffer,
    locationHeader?: string,
    retries = 0,
  ): AutobahnApiError {
    const text = this.scrub(body.toString("utf8"));
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
      (isRedirectStatus(status) || status === 300) && locationHeader ? redirectTarget(url, locationHeader) : undefined;
    return new AutobahnApiError({ status, url, method, body: text, detail, location, retries });
  }
}

/**
 * Decode a response body by the charset its Content-Type names (UTF-8 when it names
 * none). TextDecoder drops a leading byte order mark, which Buffer#toString keeps and
 * JSON.parse then rejects, so a BOM added by a proxy or a backend change cannot turn
 * a valid answer into a parse error. An unknown charset label is an
 * AutobahnParseError naming `request`. Bytes that are not valid in the charset become
 * U+FFFD, and `replaced` counts them: exactly for UTF-8 and the single-byte charsets; for
 * UTF-16 a U+FFFD the server sent counts too.
 */
function decodeBody(body: Buffer, contentType: string, request: string): { text: string; replaced: number } {
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType)?.[1] ?? "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset, { fatal: true });
  } catch {
    throw new AutobahnParseError(`${request}: unsupported response charset "${cutForMessage(sanitizeServerText(charset))}".`);
  }
  try {
    return { text: decoder.decode(body), replaced: 0 };
  } catch {
    // Not valid in the charset: decode with replacement, and count what was replaced.
    const text = new TextDecoder(decoder.encoding).decode(body);
    const sent = decoder.encoding === "utf-8" ? countBytes(body, REPLACEMENT_UTF8) : 0;
    return { text, replaced: countChar(text, 0xfffd) - sent };
  }
}

/** U+FFFD in UTF-8. */
const REPLACEMENT_UTF8 = Buffer.from([0xef, 0xbf, 0xbd]);

/** How often `needle` occurs in `body`. */
function countBytes(body: Buffer, needle: Buffer): number {
  let n = 0;
  for (let at = body.indexOf(needle); at !== -1; at = body.indexOf(needle, at + needle.length)) n++;
  return n;
}

/** How often the UTF-16 unit `code` occurs in `text`. */
function countChar(text: string, code: number): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === code) n++;
  return n;
}

/** A JSON escape of a surrogate, `\uD800`–`\uDFFF`, anywhere in a text (a cheap pre-check). */
const SURROGATE_ESCAPE = /\\u[dD][89a-fA-F][0-9a-fA-F]{2}/;

/** The value of the four hex digits of a `\uXXXX` escape whose `u` is at `at`, or -1. */
function escapeAt(json: string, at: number): number {
  if (json.charCodeAt(at) !== 0x75) return -1;
  const hex = json.slice(at + 1, at + 5);
  return /^[0-9a-fA-F]{4}$/.test(hex) ? parseInt(hex, 16) : -1;
}

/**
 * `json` (decoded answer text) with every lone surrogate written as a JSON escape (`\ud800` not
 * followed by a low-surrogate escape, or a `\udc00` not preceded by a high one) rewritten as
 * `\ufffd`, and how many. JSON.parse would make such an escape half a character, which a JSON
 * printer writes back as `\ud800` and `jq` refuses (the whole output with it). A raw lone
 * surrogate cannot occur: TextDecoder never makes one. One linear pass, and only when the text
 * holds a surrogate escape at all; the text is copied only when one is lone.
 */
function wellFormedEscapes(json: string): { json: string; replaced: number } {
  if (!SURROGATE_ESCAPE.test(json)) return { json, replaced: 0 };
  let out = "";
  let copied = 0;
  let replaced = 0;
  for (let i = 0; i < json.length; i++) {
    if (json.charCodeAt(i) !== 0x5c) continue;
    const code = escapeAt(json, i + 1);
    if (code < 0xd800 || code > 0xdfff) {
      i++; // an escape of another kind (\", \\, \n, \u0041): skip its second character
      continue;
    }
    const pairedLow = code <= 0xdbff && json.charCodeAt(i + 6) === 0x5c && isLowSurrogate(escapeAt(json, i + 7));
    if (pairedLow) {
      i += 11;
      continue;
    }
    out += json.slice(copied, i) + "\\ufffd";
    copied = i + 6;
    replaced++;
    i += 5;
  }
  return replaced === 0 ? { json, replaced } : { json: out + json.slice(copied), replaced };
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
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

/** A JSON number token, matched at a given position (sticky). */
const JSON_NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** The smallest positive normal double, 2^-1022. Below it a double has fewer significant digits. */
const MIN_NORMAL = 2.2250738585072014e-308;

/**
 * Whether the double `value` (finite) prints as the number `literal` wrote, checked where a
 * double can be off in its leading digits: past 2^53, where every double is an integer, at 0,
 * which a literal too small for a double becomes, and below the smallest normal double, where a
 * subnormal has fewer significant digits (`3e-324` becomes `5e-324`). There the CLI prints
 * `String(value)`, the shortest decimal that reads back as the same double: `12345678901234567890`
 * prints as `12345678901234567000`, a changed value, while `1E23`, `1.7976931348623157E308` or
 * `5e-324` (a double a server printed in its own shortest form) print as the same number.
 */
function exactAtTheEdges(literal: string, value: number): boolean {
  const size = Math.abs(value);
  if (value !== 0 && size <= Number.MAX_SAFE_INTEGER && size >= MIN_NORMAL) return true;
  const written = decimalOf(literal);
  if (value === 0) return written.digits === "";
  const printed = decimalOf(String(value));
  return written.negative === printed.negative && written.digits === printed.digits && written.exponent === printed.exponent;
}

/** A decimal literal as sign, significant digits (no leading or trailing zeros) and exponent: digits × 10^exponent. */
function decimalOf(text: string): { negative: boolean; digits: string; exponent: number } {
  const [, sign = "", whole = "", fraction = "", exp = "0"] = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text) ?? [];
  const all = (whole + fraction).replace(/^0+/, "");
  const digits = all.replace(/0+$/, "");
  return { negative: sign === "-", digits, exponent: Number(exp) - fraction.length + (all.length - digits.length) };
}

/** A JSON number token as the grammar allows it, matched at a given position (sticky). */
const STRICT_JSON_NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** What {@link scanNumbers} found in a JSON text. */
interface NumberScan {
  /** The text with each declared member's number value quoted; the input itself when there was none. */
  json: string;
  /** The first undeclared number literal JSON.parse cannot carry exactly, or undefined. */
  inexact: string | undefined;
}

/** Whether the member name `json` holds between `start` and `end` (its quotes) is one of `keys`, compared in place. */
function isDeclared(json: string, start: number, end: number, keys: readonly string[]): boolean {
  for (const key of keys) {
    if (end - start - 1 === key.length && json.startsWith(key, start + 1)) return true;
  }
  return false;
}

/** The index of the first character at or after `i` that is not JSON whitespace. */
function skipSpace(json: string, i: number): number {
  for (; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
  }
  return i;
}

/**
 * One linear pass over `json` (the text of an answer) that skips strings and looks at every
 * number literal:
 * - the value of a member named in `bigIntegerKeys` is quoted, as written (`"_version_":
 *   1858054135406919680` becomes `"_version_":"1858054135406919680"`), so JSON.parse delivers
 *   it exactly as a string, whatever its size. Only a literal the JSON grammar allows is quoted,
 *   so a malformed one (`01`) still fails JSON.parse;
 * - any other number is checked as {@link firstInexactNumber} says, and the first one JSON.parse
 *   cannot carry exactly is reported in `inexact`.
 * Nothing is allocated per value: a member name is compared in place (only a name written with
 * an escape is decoded), and the text is copied only when a declared member is found. No
 * reviver, which would recurse per nesting level and overflow on deep data.
 */
export function scanNumbers(json: string, bigIntegerKeys: ReadonlySet<string> = NO_KEYS): NumberScan {
  const keys = bigIntegerKeys.size === 0 ? undefined : [...bigIntegerKeys];
  let inexact: string | undefined;
  let out: string | undefined;
  let copied = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c === 0x22) {
      // a string: skip to its closing quote, past escapes
      const start = i;
      let escaped = false;
      for (i++; i < json.length; i++) {
        const d = json.charCodeAt(i);
        if (d === 0x5c) {
          escaped = true;
          i++;
        } else if (d === 0x22) break;
      }
      if (keys === undefined) continue;
      // A member name is a string followed by a colon; is it a declared one with a number value?
      const colon = skipSpace(json, i + 1);
      if (json.charCodeAt(colon) !== 0x3a) continue;
      if (!(escaped ? bigIntegerKeys.has(decodedName(json.slice(start, i + 1))) : isDeclared(json, start, i, keys))) continue;
      const at = skipSpace(json, colon + 1);
      STRICT_JSON_NUMBER.lastIndex = at;
      const literal = STRICT_JSON_NUMBER.exec(json)?.[0];
      if (literal === undefined) continue;
      out = (out ?? "") + json.slice(copied, at) + '"' + literal + '"';
      copied = at + literal.length;
      i = copied - 1;
    } else if (c === 0x2d || (c >= 0x30 && c <= 0x39)) {
      JSON_NUMBER.lastIndex = i;
      const literal = JSON_NUMBER.exec(json)?.[0];
      if (literal === undefined) continue;
      const value = Number(literal);
      if (inexact === undefined && (!Number.isFinite(value) || !exactAtTheEdges(literal, value))) {
        inexact = literal;
        if (keys === undefined) break;
      }
      i += literal.length - 1;
    }
  }
  return { json: out === undefined ? json : out + json.slice(copied), inexact };
}

/** A member name written with an escape, decoded; a name JSON.parse can't read matches nothing. */
function decodedName(quoted: string): string {
  try {
    return String(JSON.parse(quoted));
  } catch {
    return "";
  }
}

/**
 * The first number literal in `json` (JSON that parsed) that JSON.parse cannot carry exactly, or
 * undefined: one out of a double's range (`1e400` became Infinity, printed as `null`), one past
 * 2^53 that it rounds, in any form (`12345678901234567890`, `12345678901234567890.0`,
 * `9007199254740993e0`, `9007199254740992.5`), a non-zero one too small for a double
 * (`1e-400` became 0), and a subnormal one that does not print as written (`3e-324` became
 * `5e-324`). Below 2^53 and above the subnormal range a decimal fraction keeps a double's usual
 * precision, as JSON means it. {@link scanNumbers} without declared members.
 */
export function firstInexactNumber(json: string): string | undefined {
  return scanNumbers(json).inexact;
}
