// Input validation shared by the library and the CLI. Each rule is a pure
// `<thing>Problem(value)` function that returns the reason a value is invalid, or
// undefined when it is valid. The library enforces a rule with assertValid() before
// any request; the CLI's commander parsers call the same function and turn its reason
// into a usage error, so one input gets one outcome on both sides.

import { AutobahnValidationError, quoteValue } from "./errors.js";

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
 * undefined when it can: the {@link tokenProblem} rules (not blank, no control, format or
 * invisible character, no lone surrogate, which `encodeURIComponent` would throw a raw
 * URIError for), and then on the trimmed value, as the client sends it:
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
  const problem = tokenProblem(value);
  if (problem !== undefined) return problem;
  const id = value.trim();
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
 * The alphabet is an assumption about the ids the API lists (every id seen so far: 110 on 2026-10-05);
 * if `roads()` ever returns one outside it, this rule must be widened.
 */
export function roadIdProblem(value: string): string | undefined {
  const problem = idProblem(value);
  if (problem !== undefined) return problem;
  if (!/^[A-Za-z0-9 _-]+$/.test(value.trim())) return "Not a road id: road ids look like A1 or A64a.";
  return undefined;
}

/** Characters that never make a value non-blank: whitespace, controls, format characters, combining marks. */
const INVISIBLE = /[\s\p{Cc}\p{Cf}\p{M}]/gu;

/** A lone surrogate: half of a character, which URLSearchParams would send as U+FFFD. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * True when nothing in `value` would match anything: it holds only whitespace, control and
 * format characters (a zero-width space, a soft hyphen) and combining marks. Such a value reads
 * as "no filter" upstream, or matches nothing, so it is refused as blank.
 */
function isBlank(value: string): boolean {
  return value.replace(INVISIBLE, "") === "";
}

/** `U+200B` for the first character of `text` that `pattern` matches. */
function codePointOf(text: string, pattern: RegExp): string {
  const ch = pattern.exec(text)?.[0] ?? "";
  return `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

/** A control character inside a text filter: C0 and C1, but not TAB, LF or CR (whitespace in a pasted phrase). */
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

/** A format character inside a text filter, but not ZWNJ/ZWJ (U+200C/U+200D), which some scripts and emoji need. */
const TEXT_FORMAT = /(?![\u200c\u200d])\p{Cf}/u;

/**
 * Why `value` cannot be sent as a text filter, or undefined when it can. Refused, before any
 * request, as the API would match nothing or everything:
 * - a value that is blank once trimmed (Unicode whitespace, U+00A0 included), or that holds only
 *   invisible characters and combining marks (`isBlank`): an empty filter reads as "no filter"
 *   upstream, which answers with the whole unfiltered list;
 * - a lone surrogate (half of a character, sent as U+FFFD);
 * - a control character (but TAB, LF and CR) or a format character (a zero-width space, a soft
 *   hyphen, a bidi control; ZWNJ and ZWJ are allowed): pasted along, it makes the search find
 *   nothing.
 * The reason quotes the value with every invisible character escaped (`quoteValue`).
 */
export function textProblem(value: string): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  if (isBlank(value)) return "Expected a non-empty value.";
  if (LONE_SURROGATE.test(value)) return `${quoteValue(value)} contains half of a character (a lone surrogate).`;
  if (TEXT_CONTROL.test(value)) return `${quoteValue(value)} contains a control character (${codePointOf(value, TEXT_CONTROL)}).`;
  if (TEXT_FORMAT.test(value)) return `${quoteValue(value)} contains an invisible character (${codePointOf(value, TEXT_FORMAT)}).`;
  return undefined;
}

/**
 * A text filter as the API matches it: without surrounding whitespace (a value pasted with a
 * trailing space matched nothing) and in composed Unicode, NFC (a decomposed "Müller", u plus
 * U+0308 as pasted from a macOS file name, matched nothing). Inner whitespace is kept.
 * TODO(scaffold): check what the API matches; NFKC folds more (ﬁ to fi), for a search API.
 */
export function normalizeText(value: string): string {
  return value.trim().normalize("NFC");
}

/** A control or format character in a token (after trimming): every Cc and every Cf. */
const TOKEN_INVISIBLE = /[\p{Cc}\p{Cf}]/u;

/**
 * Why `value` cannot be sent as a token, or undefined when it can. A token is an id, a code, an
 * enum value or a sort key: a value the API compares exactly. The rules apply to the value with
 * surrounding whitespace trimmed, as it is sent ({@link normalizeToken}): not blank (and not only
 * invisible characters or combining marks), no lone surrogate, and no control or format character
 * at all (a zero-width space, ZWJ, a soft hyphen, a bidi control), since an invisible character in
 * an id or a code only ever makes it match nothing. The reason quotes the value visibly.
 * TODO(scaffold): check an enum or sort key against the API's known values too (or, where the API
 * lists none, against the documented syntax, such as `field-asc|desc`).
 */
export function tokenProblem(value: string): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  if (isBlank(value)) return "Expected a non-empty value.";
  const token = value.trim();
  if (LONE_SURROGATE.test(token)) return `${quoteValue(value)} contains half of a character (a lone surrogate).`;
  if (TOKEN_INVISIBLE.test(token)) {
    return `${quoteValue(value)} contains an invisible or control character (${codePointOf(token, TOKEN_INVISIBLE)}).`;
  }
  return undefined;
}

/** A token as it is sent: trimmed and in composed Unicode (NFC). Check it with {@link tokenProblem} first. */
export function normalizeToken(value: string): string {
  return value.trim().normalize("NFC");
}

/**
 * The items of a comma-separated list option (`--ids a1,a2`), as typed: each item is checked
 * (`listProblem`) and canonicalised (`normalizeToken`) on its own, so `"a1, a2"` sends `a2`, and
 * `"a1,,a2"`, `"a1,"` and `","` are refused rather than sent as an empty item (which an API may
 * read as "no filter").
 */
export function splitList(value: string): string[] {
  return value.split(",");
}

/**
 * Why `items` cannot be sent as a list, or undefined when it can: not an array of strings, no
 * item at all (an empty list reads as "no filter"), or an item that `itemProblem` refuses (by
 * default {@link tokenProblem}: a blank item is refused, never dropped). The reason names the item.
 */
export function listProblem(items: readonly string[], itemProblem: Problem = tokenProblem): string | undefined {
  if (!Array.isArray(items)) return "Expected a list of strings.";
  if (items.length === 0) return "Expected at least one value.";
  for (let i = 0; i < items.length; i++) {
    const problem = itemProblem(items[i] as string);
    if (problem !== undefined) return items.length === 1 ? problem : `item ${i + 1} of ${items.length}: ${problem}`;
  }
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
 * - a `%` in the user name or password must start a valid escape (`%25` for a literal one):
 *   Node decodes the userinfo for the Authorization header and fails at request time;
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
  // Node decodes the userinfo into the Authorization header and throws "URI malformed" for a
  // "%" that isn't an escape — at request time, as a network error. Reject it here.
  for (const part of [url.username, url.password]) {
    try {
      decodeURIComponent(part);
    } catch {
      return 'The user name or password has a "%" that is not followed by two hex digits; write a literal "%" as %25.';
    }
  }
  if (value !== value.trim()) return "A base URL cannot have surrounding whitespace.";
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return "A base URL cannot contain control characters.";
  }
  return undefined;
}
