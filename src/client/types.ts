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

/** The lane picture of a roadwork or closure: the stretch's ends and one symbol per lane. */
export interface Impact {
  /** Junction at one end of the stretch, e.g. "Eppelborn". */
  lower?: string;
  /** Junction at the other end, e.g. "Saarbrücken". */
  upper?: string;
  /** Lane symbols across the carriageway, e.g. "CLOSED", "ARROW_UP", "BREAKDOWN_LANE". */
  symbols?: string[];
}

/**
 * The shared item shape across the service listings. Every field is optional
 * because the API populates a different subset per service type (a webcam has an
 * `imageurl`, a charging station lists its connectors in `description`, and so on). The
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
   * roadworks, warnings and closures, "long,lat" for charging stations. Lorry
   * parking has none: absent from listing items, `null` in the detail response.
   */
  point?: string | null;
  coordinate?: Coordinate;
  /** Two positions ("lat,long,lat,long", or "long,lat,long,lat" for charging); as `point` for parking. */
  extent?: string | null;
  /** GeoJSON geometry of the affected stretch (roadworks, warnings, closures). */
  geometry?: JsonObject | null;
  isBlocked?: string;
  future?: boolean;
  display_type?: string;
  /** Delay in minutes on a warning, as a decimal **string** (`"10"`); `null` in other services' details. */
  delayTimeValue?: string | null;
  /** Kind of congestion on a warning (`QUEUING_TRAFFIC`, `SLOW_TRAFFIC`, …); absent on some warnings. */
  abnormalTrafficType?: string | null;
  /** Average speed in km/h on a warning, as a decimal string (`"25"`). */
  averageSpeed?: string | null;
  /**
   * Data source of a warning: `"inrix"` (traffic-flow data, `INRIX--…` identifiers, UTC
   * timestamps) or `"eva"` (the traffic centres' reports, `NLW_…` identifiers, local time).
   */
  source?: string | null;
  /** Lane picture of a roadwork or closure; `null` in other services' details. */
  impact?: Impact | null;
  /** Position code used by the app for ordering, as a decimal string; `null` on some details. */
  startLcPosition?: string | null;
  /** Feature icons of a lorry parking area (empty on every item seen live). */
  lorryParkingFeatureIcons?: JsonValue[];
  footer?: string[];
  routeRecommendation?: string[];
  /**
   * Start time. ISO 8601 on roadworks, warnings and closures; a German date
   * (`"30.03.2026"`, DD.MM.YYYY) on charging stations, where it can also be absent;
   * on lorry parking absent from listings, `null` in the detail response.
   */
  startTimestamp?: string | null;
  // Webcam-specific (the webcam service has listed nothing since 2026-09)
  imageurl?: string;
  linkurl?: string;
  /**
   * Operating organisation, documented for webcams. Charging stations do **not** send
   * it: a Deutschlandnetz site names its operator in `description`
   * (`"Ladesäulenbetreiber: …"`), the other sites not at all.
   */
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
