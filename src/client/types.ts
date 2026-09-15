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

/**
 * A geographic point with explicit `lat`/`long` keys (note `long`, not `lon`).
 * Roadworks, warnings and closures serialise the values as JSON numbers;
 * charging stations serialise them as decimal strings.
 */
export interface LatLongCoordinate {
  lat: number | string;
  long: number | string;
}

/** A GeoJSON Point: `coordinates` is `[longitude, latitude]`. */
export interface GeoJsonPoint {
  type: "Point";
  coordinates: number[];
}

/**
 * The `coordinate` field as the API serialises it. Its shape varies by service:
 * lorry parking returns a {@link GeoJsonPoint} with no `lat`/`long` keys, the
 * other services a {@link LatLongCoordinate}.
 */
export type Coordinate = LatLongCoordinate | GeoJsonPoint;

/**
 * The shared item shape across the service listings. Every field is optional
 * because the API populates a different subset per service type (a webcam has an
 * `imageurl`, a charging station has connector metadata, and so on). The
 * `identifier` is the opaque id you pass to the corresponding `get` endpoint;
 * its format varies by service.
 */
export interface AutobahnServiceItem {
  identifier?: string;
  title?: string;
  subtitle?: string;
  icon?: string;
  description?: string[];
  /**
   * Position as a string pair. The order varies by service: "lat,long" for
   * roadworks, warnings and closures, "long,lat" for charging stations; `null`
   * for lorry parking.
   */
  point?: string | null;
  coordinate?: Coordinate;
  extent?: string | null;
  /** GeoJSON geometry of the affected stretch (roadworks, warnings, closures). */
  geometry?: JsonObject | null;
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
