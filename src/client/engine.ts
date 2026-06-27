// The request engine: turns logical (method, path, query) calls into HTTP
// requests via a Transport, applies retry/backoff for transient statuses
// (429, 503), and decodes responses.

import { nodeHttpTransport, type Transport } from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import { AutobahnApiError, AutobahnNetworkError, AutobahnParseError } from "./errors.js";

export const DEFAULT_BASE_URL = "https://verkehr.autobahn.de";
const DEFAULT_USER_AGENT = "autobahn-cli";

export interface RawResponse {
  data: Buffer;
  contentType: string;
  status: number;
}

export interface EngineOptions {
  /** Base URL of the API. Defaults to https://verkehr.autobahn.de */
  baseUrl?: string;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport;
  /** Value of the User-Agent header. */
  userAgent?: string;
  /** Per-request timeout in milliseconds (0 disables). */
  timeoutMs?: number;
  /** Number of automatic retries for transient (429/503) responses. */
  maxRetries?: number;
  /**
   * Base backoff between retries in milliseconds. Grows linearly per attempt,
   * unless the response carries a `Retry-After` header, which takes precedence.
   */
  retryDelayMs?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit.
   */
  maxResponseBytes?: number;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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
    this.transport = options.transport ?? nodeHttpTransport;
    this.userAgent = options.userAgent || DEFAULT_USER_AGENT;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 200;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.sleep = options.sleep ?? realSleep;
  }

  /** Build a fully-qualified URL from a path and optional query parameters. */
  buildUrl(path: string, query?: QueryParams): string {
    // Validate the base URL up front so a malformed `baseUrl` (e.g. a stray
    // `--base-url notaurl`) yields a clear message naming the offending value,
    // instead of an opaque "Invalid URL" that carries the full request path and
    // reads as if the path were at fault.
    try {
      new URL(this.baseUrl);
    } catch {
      throw new AutobahnNetworkError(`Invalid base URL: ${JSON.stringify(this.baseUrl)}`);
    }
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
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
        const retryAfter = parseRetryAfter(response.headers["retry-after"]);
        await this.sleep(retryAfter ?? this.retryDelayMs * attempt);
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
    return new AutobahnApiError({ status, url, method, body: text, detail });
  }
}
