// AutobahnClient — a typed client over the open (no-auth) endpoints of the
// Autobahn App API (https://verkehr.autobahn.de/o/autobahn).
//
// Every service has the same two-call shape: list the items along a motorway,
// then fetch one item's details by its identifier. That symmetry is
// captured by a single generic `ServiceResource`, so the surface reads naturally:
//   client.roadworks.list("A1")
//   client.chargingStations.get(identifier)

import { RequestEngine, type EngineOptions } from "./engine.js";
import { AutobahnError, AutobahnNotFoundError, AutobahnParseError } from "./errors.js";
import type {
  RoadsResult,
  AutobahnServiceItem,
  JsonObject,
} from "./types.js";

const API_ROOT = "/o/autobahn";
// Percent-encodes one path segment. It leaves "." and ".." unchanged; the engine
// rejects those (see RequestEngine.buildUrl), so they cannot re-target a request.
const enc = encodeURIComponent;

/**
 * Validate a required path segment (motorway id / item identifier) client-side.
 * Rejects empty or whitespace-only values up front with a clear message rather
 * than building a malformed URL (`//services/...`) and leaking the upstream
 * "Cannot GET" 404 text back to the caller.
 */
function requireSegment(name: string, value: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AutobahnError(`Invalid ${name}: must be a non-empty string`);
  }
  return value;
}

/**
 * One Autobahn service (roadworks, webcam, ...). `list(roadId)` returns the
 * items along a motorway; `get(id)` returns one item's full details.
 *
 * @typeParam K - the envelope key the listing endpoint wraps its array in.
 */
class ServiceResource<K extends string> {
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
   * that list raises AutobahnNotFoundError (with a did-you-mean for a case slip)
   * instead of returning [].
   */
  async list(roadId: string): Promise<AutobahnServiceItem[]> {
    // Trim surrounding whitespace: the upstream API itself emits a few ids with a
    // trailing space (e.g. "A60 "), and copying such an id straight back in would
    // otherwise URL-encode the space and miss the road. Validate after trimming.
    const id = requireSegment("roadId", roadId).trim();
    const path = `${API_ROOT}/${enc(id)}/services/${this.service}`;
    const body = await this.engine.getJson<unknown>(path);
    // The API answers every road, even an empty one, with `{ "<key>": [...] }`. Any
    // other 2xx body (an error object, a bare array, a string, a non-array under the
    // key) is not "no items": treating it as [] would read as an all-clear.
    const items = isObject(body) ? body[this.key] : undefined;
    if (!Array.isArray(items)) throw shapeError(path, `a JSON object with a ${this.key} array`);
    if (items.length === 0) await this.assertKnownRoad(id);
    return items as AutobahnServiceItem[];
  }

  private async assertKnownRoad(id: string): Promise<void> {
    // The API's list carries a few ids with a trailing space ("A60 "); list() trims.
    const roads = (await this.knownRoads()).map((road) => road.trim());
    if (roads.includes(id)) return;
    const lower = id.toLowerCase();
    const suggestion = roads.find((road) => road.toLowerCase() === lower);
    throw new AutobahnNotFoundError(
      `Unknown road id ${JSON.stringify(id)}: not in the API's road list` +
        (suggestion === undefined ? "." : ` (did you mean ${JSON.stringify(suggestion)}?).`),
    );
  }

  /**
   * Fetch one item's details by its identifier (an opaque string; the format varies
   * by service). A 2xx body that is not a JSON object raises AutobahnParseError.
   */
  async get(identifier: string): Promise<JsonObject> {
    requireSegment("identifier", identifier);
    const path = `${API_ROOT}/details/${this.service}/${enc(identifier)}`;
    const body = await this.engine.getJson<unknown>(path);
    if (!isObject(body)) throw shapeError(path, "a JSON object");
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

  /** List all motorways the API knows about (e.g. ["A1", "A2", ...]). */
  async roads(): Promise<string[]> {
    const path = `${API_ROOT}/`;
    const body = await this.engine.getJson<unknown>(path);
    const roads = isObject(body) ? body["roads"] : undefined;
    if (!Array.isArray(roads) || !roads.every((road) => typeof road === "string")) {
      throw shapeError(path, "a JSON object with a roads array of strings");
    }
    return roads as RoadsResult["roads"];
  }
}

/** True for a JSON object (not null, not an array). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The error for a 2xx body that lacks the shape the client relies on. */
function shapeError(path: string, expected: string): AutobahnParseError {
  return new AutobahnParseError(`Unexpected response shape from ${path}: expected ${expected}.`);
}
