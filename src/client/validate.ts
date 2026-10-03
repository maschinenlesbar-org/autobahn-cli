// Input validation shared by the library and the CLI. Each rule is a pure
// `<thing>Problem(value)` function that returns the reason a value is invalid, or
// undefined when it is valid. The library enforces a rule with assertValid() before
// any request; the CLI's commander parsers call the same function and turn its reason
// into a usage error, so one input gets one outcome on both sides.

import { AutobahnValidationError } from "./errors.js";

/** Why `value` is invalid (for example `"Expected a non-empty value."`), or undefined when it is valid. */
export type Problem<T = string> = (value: T) => string | undefined;

/**
 * Return `value` when `problem(value)` finds nothing; otherwise throw an
 * {@link AutobahnValidationError} with the message `Invalid <name>: <reason>`.
 * A client method that returns a promise calls it inside its async body, so a
 * rejected input rejects the promise, and no request is sent.
 */
export function assertValid<T>(name: string, value: T, problem: Problem<T>): T {
  const reason = problem(value);
  if (reason !== undefined) throw new AutobahnValidationError(`Invalid ${name}: ${reason}`);
  return value;
}

/**
 * Why `value` cannot be used as the base URL, or undefined when it can. The engine
 * appends every request path to the base URL as a string, so the rules guard the
 * request URL it builds:
 *
 * - it must parse as an absolute URL with an `http:` or `https:` scheme (a `file:` or
 *   `ftp:` base URL would otherwise reach a custom transport that does no such check);
 * - no `?` or `#`: either would swallow every path (`http://h/?x=1` requests
 *   `/?x=1/o/autobahn/...`, `http://h/#f` requests `/`);
 * - no surrounding whitespace (U+00A0 included) and no control character anywhere:
 *   `new URL()` trims or drops them silently, but the raw string is what gets sent, so
 *   `"https://h/ "` would request `/%20/o/autobahn/`.
 *
 * The reasons never repeat the value, so a credential in it cannot reach a message.
 * The engine enforces it (as `Invalid option baseUrl: <reason>`), and the CLI's
 * `--base-url` parser calls it.
 */
export function baseUrlProblem(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Expected an absolute http(s) URL.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `Unsupported scheme "${url.protocol}". Expected an http(s) URL.`;
  }
  if (/[?#]/.test(value)) return "A base URL cannot have a query (?) or fragment (#).";
  if (value !== value.trim()) return "A base URL cannot have surrounding whitespace.";
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return "A base URL cannot contain control characters.";
  }
  return undefined;
}
