// AutobahnClient — a typed client over the open (no-auth) endpoints of the
// Autobahn App API (https://verkehr.autobahn.de/o/autobahn).
//
// Every service has the same two-call shape: list the items along a motorway,
// then fetch one item's details by its identifier. That symmetry is
// captured by a single generic `ServiceResource`, so the surface reads naturally:
//   client.roadworks.list("A1")
//   client.chargingStations.get(identifier)

import { quoteValue, RequestEngine, type EngineOptions } from "./engine.js";
import { AutobahnApiError, AutobahnError, AutobahnNotFoundError, AutobahnParseError } from "./errors.js";
import { assertValid, idProblem, roadIdProblem } from "./validate.js";
import type {
  RoadsResult,
  AutobahnServiceItem,
  JsonObject,
} from "./types.js";

const API_ROOT = "/o/autobahn";
// Percent-encodes one path segment. It leaves "." and ".." unchanged; idProblem
// rejects those (and "/", which the upstream decodes), so they cannot re-target a request.
const enc = encodeURIComponent;

/**
 * One Autobahn service (roadworks, webcam, ...). `list(roadId)` returns the
 * items along a motorway; `get(id)` returns one item's full details.
 *
 * @typeParam K - the envelope key the listing endpoint wraps its array in.
 */
export class ServiceResource<K extends string> {
  constructor(
    private readonly engine: RequestEngine,
    /** Path segment of the service, e.g. "roadworks", "electric_charging_station". */
    private readonly service: string,
    /** The JSON key the listing wraps its array in (usually === service). */
    private readonly key: K,
    /** The API's motorway list, consulted when a listing comes back empty. */
    private readonly knownRoads: () => Promise<string[]>,
  ) {}

  /**
   * List the service's items along a motorway, e.g. roadId "A1". Road ids are
   * case-sensitive. The API answers an unknown id (`A999`, `a1`) exactly like a road
   * without items, so an empty listing is checked against `roads()`: an id not in
   * that list raises AutobahnNotFoundError (with a did-you-mean for a case slip, a space
   * or dash, or a leading zero)
   * instead of returning []. That check is a second request (with its own timeout and
   * retries); if it fails, list() throws an AutobahnError naming the check, with the
   * original error as `cause`.
   */
  async list(roadId: string): Promise<AutobahnServiceItem[]> {
    // Trim surrounding whitespace: the upstream API itself emits a few ids with a
    // trailing space (e.g. "A60 "), and copying such an id straight back in would
    // otherwise URL-encode the space and miss the road. Validate after trimming.
    const id = assertValid("roadId", roadId, roadIdProblem).trim();
    const path = `${API_ROOT}/${enc(id)}/services/${this.service}`;
    const body = await getListing(this.engine, path);
    // The API answers every road, even an empty one, with `{ "<key>": [...] }`. Any
    // other 2xx body (an error object, a bare array, a string, a non-array under the
    // key) is not "no items": treating it as [] would read as an all-clear.
    const items = isObject(body) ? body[this.key] : undefined;
    if (!Array.isArray(items)) throw shapeError(this.engine.describeUrl(path), `a JSON object with a ${this.key} array`);
    // Every item the API lists is an object with a string identifier (the key for
    // get). Anything else would reach callers typed as AutobahnServiceItem and fail
    // later as a TypeError, or be skipped silently by a jq/node pipeline.
    if (!items.every((item) => isObject(item) && typeof item["identifier"] === "string")) {
      throw shapeError(this.engine.describeUrl(path), `every ${this.key} item to be a JSON object with a string identifier`);
    }
    // The other fields AutobahnServiceItem types are optional, but when present they
    // must have the promised type: `item.description?.join(...)` on a string would be a
    // TypeError in the caller's code instead of a parse error here. Only the fields a
    // consumer relies on fail the listing; a display-only field of the wrong type is
    // dropped from that item, so one cosmetic upstream change cannot take every listing down.
    const checked = items.map((item, index) => {
      const problem = fieldProblem(item as Record<string, unknown>);
      if (problem !== undefined) {
        throw shapeError(this.engine.describeUrl(path), `${this.key} item ${index} to have ${problem}`);
      }
      return withoutMistypedDisplayFields(item as Record<string, unknown>);
    });
    if (checked.length === 0) await this.assertKnownRoad(id);
    return checked as AutobahnServiceItem[];
  }

  private async assertKnownRoad(id: string): Promise<void> {
    // The listing itself succeeded, so a failure here is about the check, not the
    // service the caller asked for: say so, instead of a bare error naming the road
    // list endpoint. AutobahnError (CLI exit 1); the original error is the cause.
    let known: string[];
    try {
      known = await this.knownRoads();
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new AutobahnError(
        `Could not check road id ${quoteValue(id)} against the API's road list ` +
          `(the ${this.service} listing was empty): ${reason}`,
        { cause },
      );
    }
    // An empty road list is an upstream fault, not proof that the road does not exist:
    // reporting every id as unknown (exit 4) would read as "no such road".
    if (known.length === 0) {
      throw new AutobahnError(
        `Could not check road id ${quoteValue(id)} against the API's road list ` +
          `(the ${this.service} listing was empty): the road list itself is empty.`,
      );
    }
    // roads() returns trimmed ids, as list() trims its own.
    if (known.includes(id)) return;
    const key = roadKey(id);
    const suggestion = known.find((road) => roadKey(road) === key);
    throw new AutobahnNotFoundError(
      `Unknown road id ${quoteValue(id)}: not in the API's road list` +
        (suggestion === undefined ? "." : ` (did you mean ${quoteValue(suggestion)}?).`),
    );
  }

  /**
   * Fetch one item's details by its identifier (an opaque string; the format varies
   * by service). Surrounding whitespace is trimmed, as list() does for road ids: no
   * identifier the API issues has any, so a stray space from a copy-paste would
   * otherwise read as "not found". An identifier containing "/" is rejected like such a
   * road id (idProblem): `"x/../<id>"` would otherwise resolve to `<id>`. A 2xx body
   * that is not a JSON object, or one whose `identifier` is not the one asked for,
   * raises AutobahnParseError.
   */
  async get(identifier: string): Promise<JsonObject> {
    const id = assertValid("identifier", identifier, idProblem).trim();
    const path = `${API_ROOT}/details/${this.service}/${enc(id)}`;
    // The detail endpoint answers an unknown identifier with 200 and an empty body.
    const body = await this.engine.getJson<unknown>(path, undefined, { emptyIsNotFound: true });
    if (!isObject(body)) throw shapeError(this.engine.describeUrl(path), "a JSON object");
    // The API echoes the identifier it resolved (checked live for every service). An
    // answer about another item would otherwise print with exit 0 as if it were the one
    // asked for.
    // Compared trimmed, as get() trims its input: the API emits ids with a stray
    // trailing space elsewhere ("A60 " in the road list), which is no other item.
    const answered = body["identifier"];
    if (typeof answered !== "string" || answered.trim() !== id) {
      const got = describeIdentifier(body["identifier"]);
      throw new AutobahnParseError(
        `Unexpected response from ${this.engine.describeUrl(path)}: asked for identifier ${quoteValue(id)}, got ${got}.`,
      );
    }
    return body as JsonObject;
  }
}

export class AutobahnClient {
  private readonly engine: RequestEngine;

  readonly roadworks: ServiceResource<"roadworks">;
  readonly webcams: ServiceResource<"webcam">;
  readonly parkingLorries: ServiceResource<"parking_lorry">;
  readonly warnings: ServiceResource<"warning">;
  readonly closures: ServiceResource<"closure">;
  readonly chargingStations: ServiceResource<"electric_charging_station">;

  constructor(options: EngineOptions = {}) {
    this.engine = new RequestEngine(options);
    const roads = (): Promise<string[]> => this.roads();

    this.roadworks = new ServiceResource(this.engine, "roadworks", "roadworks", roads);
    this.webcams = new ServiceResource(this.engine, "webcam", "webcam", roads);
    this.parkingLorries = new ServiceResource(this.engine, "parking_lorry", "parking_lorry", roads);
    this.warnings = new ServiceResource(this.engine, "warning", "warning", roads);
    this.closures = new ServiceResource(this.engine, "closure", "closure", roads);
    this.chargingStations = new ServiceResource(
      this.engine,
      "electric_charging_station",
      "electric_charging_station",
      roads,
    );
  }

  /**
   * List all motorways the API knows about (e.g. ["A1", "A2", ...]), in the API's
   * order. Each id is trimmed, blank ids are dropped and duplicates removed (the first
   * occurrence is kept): the API lists both "A60" and "A60 ", and since `list()` trims
   * its road id, both name the same road.
   */
  async roads(): Promise<string[]> {
    const path = `${API_ROOT}/`;
    const body = await getListing(this.engine, path);
    const roads = isObject(body) ? body["roads"] : undefined;
    if (!Array.isArray(roads) || !roads.every((road) => typeof road === "string")) {
      throw shapeError(this.engine.describeUrl(path), "a JSON object with a roads array of strings");
    }
    const ids = (roads as RoadsResult["roads"]).map((id) => id.trim()).filter((id) => id !== "");
    return [...new Set(ids)];
  }
}

/**
 * A road id reduced to what tells roads apart, for the did-you-mean: case, spaces,
 * dashes and underscores and leading zeros of the number are dropped, so `a1`, `A 1`,
 * `A-1` and `A01` all match `A1`, and `A64A` matches `A64a`.
 */
function roadKey(id: string): string {
  return id.toLowerCase().replace(/[\s_-]+/g, "").replace(/^([a-z]+)0+(?=\d)/, "$1");
}

/**
 * GET a listing (the road list or a service listing). Neither answers 404 to a valid
 * request — an unknown road id gets an empty listing — so a 404 here means the base URL
 * points somewhere else (a wrong path prefix, a proxy's error page). That is a
 * configuration error, raised as an AutobahnError (CLI exit 1) with the API error as
 * `cause`, not a "not found" (exit 4) that a script would read as "no such item".
 */
async function getListing(engine: RequestEngine, path: string): Promise<unknown> {
  try {
    return await engine.getJson<unknown>(path);
  } catch (cause) {
    if (cause instanceof AutobahnApiError && cause.status === 404) {
      throw new AutobahnError(
        `${cause.message} — the road list and the service listings never answer 404, so the base URL is probably wrong.`,
        { cause },
      );
    }
    throw cause;
  }
}

/**
 * How an identifier mismatch message shows the identifier the API answered with: quoted
 * when a string, `none` when the field is missing, a number or boolean with its type
 * (`123 (a number)`), otherwise its kind — so the message does not point at a missing
 * field when the value is merely of the wrong type.
 */
function describeIdentifier(value: unknown): string {
  if (value === undefined) return "none";
  if (typeof value === "string") return quoteValue(value);
  if (typeof value === "number" || typeof value === "boolean") return `${String(value)} (a ${typeof value})`;
  if (value === null) return "null";
  return Array.isArray(value) ? "an array" : "an object";
}

const isString = (v: unknown): boolean => typeof v === "string";
const isStringOrNull = (v: unknown): boolean => v === null || typeof v === "string";
const isObjectOrNull = (v: unknown): boolean => v === null || isObject(v);
const isStringArray = (v: unknown): boolean => Array.isArray(v) && v.every(isString);

/**
 * The type each optional AutobahnServiceItem field must have when present, with how a
 * message names it. Every one of 1 487 live items checked (all six services, over ten roads,
 * 2026-10-04/05) passes.
 * `strict` fields — the ones the skills and typical consumers read — fail the listing when
 * mistyped; the display-only rest is dropped from the item instead.
 */
const FIELD_RULES: Array<[field: string, ok: (v: unknown) => boolean, expected: string, strict: boolean]> = [
  ["title", isString, "a string", true],
  ["subtitle", isString, "a string", true],
  ["display_type", isString, "a string", true],
  ["isBlocked", isString, "a string", true],
  ["future", (v) => typeof v === "boolean", "a boolean", true],
  ["description", isStringArray, "an array of strings", true],
  ["routeRecommendation", isStringArray, "an array of strings", true],
  ["point", isStringOrNull, "a string or null", true],
  ["extent", isStringOrNull, "a string or null", true],
  ["startTimestamp", isStringOrNull, "a string or null", true],
  ["coordinate", isObject, "an object", true],
  ["geometry", isObjectOrNull, "an object or null", true],
  ["delayTimeValue", isStringOrNull, "a string or null", true],
  ["abnormalTrafficType", isStringOrNull, "a string or null", true],
  ["imageurl", isString, "a string", true],
  ["linkurl", isString, "a string", true],
  ["icon", isString, "a string", false],
  ["footer", isStringArray, "an array of strings", false],
  ["impact", isObjectOrNull, "an object or null", false],
  ["averageSpeed", isStringOrNull, "a string or null", false],
  ["source", isStringOrNull, "a string or null", false],
  ["startLcPosition", isStringOrNull, "a string or null", false],
  ["lorryParkingFeatureIcons", Array.isArray, "an array", false],
  ["operator", isString, "a string", false],
];

/** The first strict field of a listing item that has the wrong type, as `"field" as <type>`. */
function fieldProblem(item: Record<string, unknown>): string | undefined {
  for (const [field, ok, expected, strict] of FIELD_RULES) {
    if (strict && field in item && !ok(item[field])) return `"${field}" as ${expected}`;
  }
  return undefined;
}

/** `item` without its display-only fields of the wrong type (the same object when there are none). */
function withoutMistypedDisplayFields(item: Record<string, unknown>): Record<string, unknown> {
  const mistyped = FIELD_RULES.filter(([field, ok, , strict]) => !strict && field in item && !ok(item[field]));
  if (mistyped.length === 0) return item;
  const copy = { ...item };
  for (const [field] of mistyped) delete copy[field];
  return copy;
}

/** True for a JSON object (not null, not an array). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The error for a 2xx body that lacks the shape the client relies on. */
function shapeError(url: string, expected: string): AutobahnParseError {
  return new AutobahnParseError(`Unexpected response shape from ${url}: expected ${expected}.`);
}
