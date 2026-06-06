// Domain types for the Autobahn App API (verkehr.autobahn.de).
//
// The service listings (roadworks, warnings, closures, ...) share a loosely
// specified item shape; the documented common fields are typed precisely below.
// Single-item "details" responses are returned as faithful raw `JsonObject`s
// rather than partially-guessed types.

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** Response of `GET /` — the list of motorways the API knows about. */
export interface RoadsResult {
  roads: string[];
}

/** A geographic point as the API serialises it (stringified decimals). */
export interface Coordinate {
  lat: string;
  long: string;
}

/**
 * The shared item shape across the service listings. Every field is optional
 * because the API populates a different subset per service type (a webcam has an
 * `imageurl`, a charging station has connector metadata, and so on). The
 * `identifier` is the base64 id you pass to the corresponding `get` endpoint.
 */
export interface AutobahnServiceItem {
  identifier?: string;
  title?: string;
  subtitle?: string;
  icon?: string;
  description?: string[];
  /** "lat,long" pair, present on most items. */
  point?: string;
  coordinate?: Coordinate;
  extent?: string;
  isBlocked?: string;
  future?: boolean;
  display_type?: string;
  footer?: string[];
  routeRecommendation?: string[];
  startTimestamp?: string;
  // Webcam-specific
  imageurl?: string;
  linkurl?: string;
  operator?: string;
}

/** `GET /{roadId}/services/{service}` envelopes — keyed by the service name. */
export interface RoadworksResult {
  roadworks: AutobahnServiceItem[];
}
export interface WebcamResult {
  webcam: AutobahnServiceItem[];
}
export interface ParkingLorryResult {
  parking_lorry: AutobahnServiceItem[];
}
export interface WarningResult {
  warning: AutobahnServiceItem[];
}
export interface ClosureResult {
  closure: AutobahnServiceItem[];
}
export interface ElectricChargingStationResult {
  electric_charging_station: AutobahnServiceItem[];
}

/** Single-item detail payloads — kept as raw JSON objects. */
export type RoadworkDetail = JsonObject;
export type WebcamDetail = JsonObject;
export type ParkingLorryDetail = JsonObject;
export type WarningDetail = JsonObject;
export type ClosureDetail = JsonObject;
export type ElectricChargingStationDetail = JsonObject;
