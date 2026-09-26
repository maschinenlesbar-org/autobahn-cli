// AutobahnClient — a typed client over the open (no-auth) endpoints of the
// Autobahn App API (https://verkehr.autobahn.de/o/autobahn).
//
// Every service has the same two-call shape: list the items along a motorway,
// then fetch one item's details by its identifier. That symmetry is
// captured by a single generic `ServiceResource`, so the surface reads naturally:
//   client.roadworks.list("A1")
//   client.chargingStations.get(identifier)

import { RequestEngine, type EngineOptions } from "./engine.js";
import { AutobahnError, AutobahnParseError } from "./errors.js";
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
  ) {}

  /** List the service's items along a motorway, e.g. roadId "A1". */
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
    return items as AutobahnServiceItem[];
  }

  /** Fetch one item's details by its identifier (an opaque string; the format varies by service). */
  get(identifier: string): Promise<JsonObject> {
    requireSegment("identifier", identifier);
    return this.engine.getJson(`${API_ROOT}/details/${this.service}/${enc(identifier)}`);
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

    this.roadworks = new ServiceResource(this.engine, "roadworks", "roadworks");
    this.webcams = new ServiceResource(this.engine, "webcam", "webcam");
    this.parkingLorries = new ServiceResource(this.engine, "parking_lorry", "parking_lorry");
    this.warnings = new ServiceResource(this.engine, "warning", "warning");
    this.closures = new ServiceResource(this.engine, "closure", "closure");
    this.chargingStations = new ServiceResource(
      this.engine,
      "electric_charging_station",
      "electric_charging_station",
    );
  }

  /** List all motorways the API knows about (e.g. ["A1", "A2", ...]). */
  async roads(): Promise<string[]> {
    const path = `${API_ROOT}/`;
    const body = await this.engine.getJson<unknown>(path);
    const roads = isObject(body) ? body["roads"] : undefined;
    if (!Array.isArray(roads)) throw shapeError(path, "a JSON object with a roads array");
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
