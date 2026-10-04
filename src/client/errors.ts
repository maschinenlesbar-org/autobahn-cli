// Error types raised by the client. Kept free of any I/O so they are trivial to
// construct in tests and to `instanceof`-check by consumers.

/**
 * Replace the userinfo of a URL (`https://user:secret@host/...`) with `***`, so a
 * credential in a base URL never reaches an error message, a log or CI output.
 * A URL without userinfo, or one that does not parse, is returned unchanged.
 */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.username === "" && parsed.password === "") return url;
  parsed.username = "***";
  parsed.password = "";
  return parsed.href;
}

/**
 * Longest URL or echoed value (in characters) an error message shows, like the 500
 * characters kept of a server `detail`. A 20 000-character road id would otherwise put a
 * 20 KB URL on one stderr line. The error's `url` property keeps the full value.
 */
export const MAX_MESSAGE_VALUE_LENGTH = 500;

/** `text` cut to MAX_MESSAGE_VALUE_LENGTH characters, ending in "…" when cut. */
export function cutForMessage(text: string): string {
  return text.length > MAX_MESSAGE_VALUE_LENGTH ? `${text.slice(0, MAX_MESSAGE_VALUE_LENGTH)}…` : text;
}

/**
 * True for the statuses the engine retries as transient: `429` (rate-limited), `503`
 * (service unavailable), and `502`/`504`, which the gateway in front of the API answers
 * when a backend is briefly unreachable (a `502` seen live recovered within seconds).
 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

/** Base class for every error originating from this client. */
export class AutobahnError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The API responded with a non-2xx status code. `detail` holds a human-readable
 * message extracted from the response body when one is present. For a 3xx — the
 * client does not follow redirects — `location` holds the redirect target
 * (absolute, sanitised, userinfo redacted) and the message names it.
 */
export class AutobahnApiError extends AutobahnError {
  readonly status: number;
  readonly detail: string | undefined;
  readonly url: string;
  readonly method: string;
  readonly body: string;
  readonly location: string | undefined;
  /** How many times the engine retried the request before giving up (0 when it did not). */
  readonly retries: number;

  constructor(args: {
    status: number;
    url: string;
    method: string;
    body: string;
    detail?: string;
    location?: string;
    retries?: number;
  }) {
    // The URL is shown without userinfo: a credential in --base-url must not leak.
    const url = redactUrl(args.url);
    const parts: string[] = [];
    if (args.detail) parts.push(args.detail);
    if (args.status >= 300 && args.status < 400) {
      parts.push(
        args.location
          ? `redirect to ${args.location} not followed`
          : "redirect not followed (no Location header)",
      );
    }
    const detailPart = parts.length > 0 ? `: ${parts.join("; ")}` : "";
    const retries = args.retries ?? 0;
    // Say that the status persisted through retries, so a user knows whether raising
    // --max-retries could help.
    const retryPart = retries > 0 ? ` (after ${retries} ${retries === 1 ? "retry" : "retries"})` : "";
    super(`HTTP ${args.status} for ${args.method} ${cutForMessage(url)}${detailPart}${retryPart}`);
    this.status = args.status;
    this.url = url;
    this.method = args.method;
    this.body = args.body;
    this.detail = args.detail;
    this.location = args.location;
    this.retries = retries;
  }

  /** True for the transient statuses the engine retries (isRetryableStatus). */
  get isRetryable(): boolean {
    return isRetryableStatus(this.status);
  }
}

/**
 * Something the caller named does not exist, although the API answered 2xx — a road
 * id that is not in the API's road list (a typo, or `a1` for `A1`; the API answers
 * such an id with an empty listing, which would otherwise read as "no items"), or an
 * identifier the detail endpoint answers with an empty body (`get`).
 */
export class AutobahnNotFoundError extends AutobahnError {}

/**
 * An input the library rejects before sending any request: a client option or a
 * method argument that breaks one of the rules in `validate.ts`. The message reads
 * `Invalid <name>: <reason>`. The CLI reports it as a usage error (exit 2).
 */
export class AutobahnValidationError extends AutobahnError {}

/** A transport-level failure (DNS, connection reset, timeout, ...). */
export class AutobahnNetworkError extends AutobahnError {}

/** The response body could not be parsed as the expected JSON shape. */
export class AutobahnParseError extends AutobahnError {}
