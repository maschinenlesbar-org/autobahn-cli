// HTTP transport built on Node's built-in `http`/`https` modules — no axios,
// no fetch polyfill, no third-party HTTP client.
//
// The transport is a plain function so it can be trivially swapped out in tests
// (inject a `mock.fn()` returning a canned HttpResponse) without touching the
// network. The default implementation below is exercised against a real local
// `http.createServer` in the test-suite.

import http from "node:http";
import https from "node:https";
import { AutobahnNetworkError, redactUrl } from "./errors.js";

export interface HttpRequest {
  method: string;
  /** Fully-qualified absolute URL. */
  url: string;
  headers?: Record<string, string>;
  /** Optional request body (already serialised). */
  body?: string | Buffer;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Hard cap on the response body size in bytes; the request aborts if exceeded. */
  maxResponseBytes?: number;
}

export interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

/**
 * The longest delay Node's timers support (2^31 - 1 ms, about 24.8 days). A longer one
 * prints a TimeoutOverflowWarning and fires after 1 ms, so timeouts are capped here.
 */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Default transport. Resolves with the raw response (including non-2xx) — status
 * interpretation is the client's job. Rejects only on transport-level failures
 * (connection errors, timeouts, malformed URLs).
 */
export const nodeHttpTransport: Transport = (request) =>
  new Promise<HttpResponse>((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      reject(new AutobahnNetworkError(`Invalid URL: ${redactUrl(request.url)}`));
      return;
    }

    // Only http/https are supported. Reject anything else up front with a clear,
    // typed error instead of letting Node throw an opaque ERR_INVALID_PROTOCOL
    // (and so this never reaches the file:/ftp:/etc. drivers).
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      reject(new AutobahnNetworkError(`Unsupported protocol "${url.protocol}" in URL: ${redactUrl(request.url)}`));
      return;
    }

    const isHttps = url.protocol === "https:";
    const driver = isHttps ? https : http;
    const maxBytes = request.maxResponseBytes;
    const timeoutMs = request.timeoutMs && request.timeoutMs > 0 ? request.timeoutMs : 0;

    // Wall-clock deadline. `req.setTimeout` below is only a *socket-inactivity*
    // timeout: a hostile server that drips one byte every few seconds resets it
    // forever, so total request duration would otherwise be unbounded even with the
    // size cap intact. This timer, armed once at request start, caps the whole
    // exchange and is cleared on every settle path so it never leaks.
    let deadline: NodeJS.Timeout | undefined;
    const clearDeadline = (): void => {
      if (deadline !== undefined) {
        clearTimeout(deadline);
        deadline = undefined;
      }
    };
    const settleResolve = (value: HttpResponse): void => {
      clearDeadline();
      resolve(value);
    };
    const settleReject = (err: Error): void => {
      clearDeadline();
      reject(err);
    };

    const req = driver.request(
      url,
      {
        method: request.method,
        headers: request.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let received = 0;
        let aborted = false;

        res.on("data", (chunk: Buffer) => {
          if (aborted) return;
          received += chunk.length;
          if (maxBytes !== undefined && received > maxBytes) {
            aborted = true;
            res.destroy();
            settleReject(new AutobahnNetworkError(`Response exceeded maxResponseBytes (${maxBytes})`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (aborted) return;
          settleResolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
        res.on("error", (err) => {
          if (aborted) return; // we already rejected with the size-cap error
          settleReject(new AutobahnNetworkError(`Response stream error: ${err.message}`, { cause: err }));
        });
      },
    );

    if (timeoutMs > 0) {
      const timerMs = Math.min(timeoutMs, MAX_TIMEOUT_MS);
      req.setTimeout(timerMs, () => {
        req.destroy(new AutobahnNetworkError(`Request timed out after ${timeoutMs}ms`));
      });
      deadline = setTimeout(() => {
        req.destroy(
          new AutobahnNetworkError(`Request exceeded overall deadline of ${timeoutMs}ms`),
        );
      }, timerMs);
      // Don't let the deadline timer keep the event loop alive on its own.
      deadline.unref?.();
    }

    req.on("error", (err) => {
      // A timeout/deadline destroy already passes an AutobahnNetworkError; don't double-wrap.
      settleReject(err instanceof AutobahnNetworkError ? err : new AutobahnNetworkError(err.message, { cause: err }));
    });

    if (request.body !== undefined) req.write(request.body);
    req.end();
  });
