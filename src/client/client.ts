// AutobahnClient — a typed client over the open (no-auth) endpoints of the
// Autobahn App API (https://verkehr.autobahn.de/o/autobahn).
//
// Every service has the same two-call shape: list the items along a motorway,
// then fetch one item's details by its (base64) identifier. That symmetry is
// captured by a single generic `ServiceResource`, so the surface reads naturally:
//   client.roadworks.list("A1")
//   client.chargingStations.get(identifier)

import { RequestEngine, type EngineOptions } from "./engine.js";
import type {
  RoadsResult,
  AutobahnServiceItem,
  JsonObject,
} from "./types.js";

const API_ROOT = "/o/autobahn";
const enc = encodeURIComponent;

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
    const res = await this.engine.getJson<Record<K, AutobahnServiceItem[]>>(
      `${API_ROOT}/${enc(roadId)}/services/${this.service}`,
    );
    const items = res[this.key];
    return Array.isArray(items) ? items : [];
  }

  /** Fetch one item's details by its (base64) identifier. */
  get(identifier: string): Promise<JsonObject> {
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
    const res = await this.engine.getJson<RoadsResult>(`${API_ROOT}/`);
    return Array.isArray(res.roads) ? res.roads : [];
  }
}
