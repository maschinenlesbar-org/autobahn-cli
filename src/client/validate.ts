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
 * Why `value` cannot be put into a request path as a road id or item identifier, or
 * undefined when it can. The rules apply to the value with surrounding whitespace
 * trimmed, as the client sends it.
 *
 * A blank value is rejected (it would build `//services/...` and leak the upstream
 * "Cannot GET" text). The client percent-encodes the id, but the upstream decodes `%2F` back to `/` and
 * resolves `..` before routing, so `"A1/../A2"` would fetch the A2 data (exit 0) and
 * `"A2/"` would pass for `"A2"`; `get("x/../<id>")` would fetch `<id>`. No road id or
 * identifier the API issues contains a `/` (one that did could not be fetched either:
 * the upstream would route it as two segments). `"."` and `".."` are rejected too:
 * percent-encoding leaves them unchanged and URL parsing would resolve them.
 */
export function idProblem(value: string): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  const id = value.trim();
  if (id === "") return "Expected a non-empty value.";
  if (id.includes("/")) return 'An id cannot contain "/": the API reads it as a path separator.';
  if (id === "." || id === "..") return '"." and ".." are not ids.';
  return undefined;
}

/**
 * Why `value` cannot be a road id, or undefined when it can: idProblem, and then only
 * letters, digits, spaces, dashes and underscores. Every road id the API lists matches
 * `A<number>[letter]`; spaces, dashes and underscores stay allowed so that `A 1` or `A-1`
 * reaches the did-you-mean. Anything else (`%`, `~`, `A1;x`) cannot name a road and used
 * to cost two requests (the listing and the road-list check) before "Unknown road id".
 * The alphabet is an assumption about the ids the API lists (all 109 in October 2026);
 * if `roads()` ever returns one outside it, this rule must be widened.
 */
export function roadIdProblem(value: string): string | undefined {
  const problem = idProblem(value);
  if (problem !== undefined) return problem;
  if (!/^[A-Za-z0-9 _-]+$/.test(value.trim())) return "Not a road id: road ids look like A1 or A64a.";
  return undefined;
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
