// The request engine: turns logical (method, path, query) calls into HTTP
// requests via a Transport, applies retry/backoff for transient statuses
// (429, 503), and decodes responses.

import { MAX_TIMEOUT_MS, nodeHttpTransport, type Transport } from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import {
  AutobahnApiError,
  AutobahnError,
  AutobahnNetworkError,
  AutobahnParseError,
  redactUrl,
} from "./errors.js";

export const DEFAULT_BASE_URL = "https://verkehr.autobahn.de";
const DEFAULT_USER_AGENT = "autobahn-cli";

export interface RawResponse {
  data: Buffer;
  contentType: string;
  status: number;
}

/**
 * Options for {@link RequestEngine} and the client. The numeric options must be
 * integers within their documented range; anything else (negative, fractional,
 * NaN, Infinity, too large) makes the constructor throw an AutobahnError.
 */
export interface EngineOptions {
  /** Base URL of the API. Defaults to https://verkehr.autobahn.de */
  baseUrl?: string;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport;
  /** Value of the User-Agent header. */
  userAgent?: string;
  /** Per-request timeout in milliseconds (0 disables; at most `MAX_TIMEOUT_MS`, 2^31 - 1 ms). */
  timeoutMs?: number;
  /** Number of automatic retries for transient (429/503) responses, 0..`MAX_RETRIES` (10). */
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

/** Most automatic retries a caller may ask for (the CLI's --max-retries shares it). */
export const MAX_RETRIES = 10;

/**
 * Reject a base URL whose scheme is not http(s). The default transport already
 * gates this per hop, but the engine is exported as a library and may be handed a
 * custom transport that does no such check, so gate the configured base URL here
 * too (a `file:`/`ftp:` base URL fails fast with a typed error). A malformed base
 * URL gets a clear message naming the offending value, instead of an opaque
 * "Invalid URL" that would carry the full request path. Request paths are appended
 * to the base URL as a string, so a `?` or `#` in it would swallow every path:
 * `http://h/?x=1` requests `/?x=1/o/autobahn/...` and `http://h/#f` requests `/`.
 */
function assertHttpScheme(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new AutobahnNetworkError(`Invalid base URL: ${JSON.stringify(redactUrl(baseUrl))}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AutobahnNetworkError(
      `Unsupported protocol "${url.protocol}" in base URL: ${JSON.stringify(redactUrl(baseUrl))}`,
    );
  }
  if (/[?#]/.test(baseUrl)) {
    throw new AutobahnNetworkError(`Base URL must not contain a query or fragment: ${redactUrl(baseUrl)}`);
  }
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Strip control characters out of a string that originates in an
 * attacker-controlled response — here the API error `detail` extracted from the
 * response body. `JSON.parse` decodes a JSON-escaped ESC (a backslash-u-001b
 * sequence) in an error body into a real ESC byte, so without this a hostile or
 * MITM'd endpoint could drive ANSI/OSC escape sequences into the user's terminal
 * when the message is printed raw to stderr (display spoofing, title changes).
 * Removes all C0/C1 controls except tab and newline, plus DEL. The CLI's JSON output
 * is escaped separately (`escapeControlChars` in cli/shared.ts): `JSON.stringify`
 * alone leaves DEL and the C1 range raw.
 *
 * Implemented as a char-code filter (not a regex with control-char literals) so no
 * raw control byte ever appears in this source file.
 */
function sanitizeServerText(text: string): string {
  let out = "";
  for (const ch of text) {
    const n = ch.codePointAt(0) ?? 0;
    // strip C0 (except tab 0x09 / newline 0x0a), plus DEL and C1 (0x7f-0x9f)
    if (n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f)) continue;
    out += ch;
  }
  return out;
}

/**
 * Parse a `Retry-After` header into a delay in milliseconds, supporting both
 * the delta-seconds form (`Retry-After: 120`) and the HTTP-date form
 * (`Retry-After: Wed, 21 Oct 2025 07:28:00 GMT`). Returns `undefined` when the
 * header is absent or unparseable so the caller can fall back to its own backoff.
 */
export function parseRetryAfter(value: string | string[] | undefined): number | undefined {
  const raw = (Array.isArray(value) ? value[0] : value)?.trim();
  if (!raw) return undefined;

  if (/^\d+$/.test(raw)) {
    return Number(raw) * 1000;
  }

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
    throw new AutobahnError(
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
    // Use `||` (not `??`) for the string options so that an empty string — which
    // commander can hand us from `--base-url ""` / `--user-agent ""` — falls back
    // to the default rather than producing an invalid URL or a blank UA header.
    this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    assertHttpScheme(this.baseUrl);
    this.transport = options.transport ?? nodeHttpTransport;
    this.userAgent = options.userAgent || DEFAULT_USER_AGENT;
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
   * Throws an AutobahnError for a path with a "." or ".." segment. The client puts
   * road ids and identifiers into the path with `encodeURIComponent`, which leaves
   * those two unchanged, and URL parsing then resolves them: `roadworks list ..`
   * would request `/o/services/roadworks` and report "no roadworks" with exit 0.
   * Neither can name a resource. (Percent-encoded forms such as "%2e%2e" are safe:
   * encodeURIComponent turns their "%" into "%25".)
   */
  buildUrl(path: string, query?: QueryParams): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const dotSegment = normalizedPath.split("/").find((s) => s === "." || s === "..");
    if (dotSegment !== undefined) {
      throw new AutobahnError(
        `Invalid path segment "${dotSegment}" in ${normalizedPath}: "." and ".." cannot be used as an id.`,
      );
    }
    const qs = query ? buildQueryString(query) : "";
    return `${this.baseUrl}${normalizedPath}${qs ? `?${qs}` : ""}`;
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
      const response = await this.transport({
        method,
        url,
        headers,
        timeoutMs: this.timeoutMs,
        ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
      });

      const status = response.status;
      const retryable = status === 429 || status === 503;
      if (retryable && attempt < this.maxRetries) {
        attempt += 1;
        // Honour a Retry-After header when present, clamped to MAX_RETRY_AFTER_MS
        // so a pathological/hostile value can't hang the CLI; otherwise fall back
        // to linear backoff.
        const retryAfter = parseRetryAfter(response.headers["retry-after"]);
        const delay =
          retryAfter !== undefined
            ? Math.min(retryAfter, MAX_RETRY_AFTER_MS)
            : this.retryDelayMs * attempt;
        await this.sleep(delay);
        continue;
      }

      const contentType = String(response.headers["content-type"] ?? "");
      if (status < 200 || status >= 300) {
        throw this.toApiError(method, url, status, response.body);
      }

      return { data: response.body, contentType, status };
    }
  }

  /** Perform a GET expecting JSON and parse it into `T`. */
  async getJson<T>(path: string, query?: QueryParams): Promise<T> {
    const res = await this.request("GET", path, { query, accept: "application/json" });
    const text = res.data.toString("utf8");
    // The Autobahn detail endpoint answers an unknown identifier with HTTP 200
    // and an *empty* body rather than a 404. Treat an empty (or whitespace-only)
    // body as "not found" so it surfaces as a 404 AutobahnApiError (exit 4)
    // instead of a misleading JSON parse error.
    if (text.trim() === "") {
      throw new AutobahnApiError({
        status: 404,
        url: this.buildUrl(path, query),
        method: "GET",
        body: text,
        detail: "Not found (empty response body)",
      });
    }
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new AutobahnParseError(`Failed to parse JSON response from ${path}`, { cause });
    }
  }

  private toApiError(method: string, url: string, status: number, body: Buffer): AutobahnApiError {
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
    // endpoint cannot inject terminal escape sequences via the stderr error message.
    if (detail !== undefined) detail = sanitizeServerText(detail);
    return new AutobahnApiError({ status, url, method, body: text, detail });
  }
}
