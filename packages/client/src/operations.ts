// The use cases of the skills as library functions, built on the resources: each composes the
// client's calls and carries the traps the skills document, so no caller (the CLI, the MCP
// server's tools, a library user) has to know them.
// - checkRoad: the disruption picture of one motorway (the route-check skill);
// - findChargingStations: the charging sites along one motorway, in road order (the EV planner).
// An unknown road id is the client's AutobahnNotFoundError with a did-you-mean, never an empty
// answer that would read as "all clear".

import type { AutobahnClient } from "./client.js";
import type { AutobahnServiceItem, Coordinate } from "./types.js";

/** The services a road listing comes from, as the CLI names them. */
export const SERVICE_NAMES = ["roadworks", "webcams", "parking", "warnings", "closures", "charging"] as const;
export type ServiceName = (typeof SERVICE_NAMES)[number];

/** The client's resource for a service name. */
export function serviceResource(client: AutobahnClient, service: ServiceName) {
  switch (service) {
    case "roadworks":
      return client.roadworks;
    case "webcams":
      return client.webcams;
    case "parking":
      return client.parkingLorries;
    case "warnings":
      return client.warnings;
    case "closures":
      return client.closures;
    case "charging":
      return client.chargingStations;
  }
}

/** One item of a road check, cut to what a briefing needs. */
export interface CheckedItem {
  service: "warnings" | "closures" | "roadworks";
  identifier: string;
  title: string;
  /** The direction, trimmed (`Euskirchen -> Dortmund`). */
  direction?: string;
  displayType?: string;
  /** True when the API marks it as planned (`future`); false is not proof that it is active. */
  planned: boolean;
  /** A warning's delay in minutes (the API sends a string). */
  delayMinutes?: number;
  trafficType?: string;
  /** The item's German detail lines, joined: the time window and the cause are only here. */
  description: string;
}

/** The answer of {@link checkRoad}. */
export interface RoadCheck {
  roadId: string;
  counts: {
    warnings: number;
    /** Carriageway closures (`CLOSURE`), from the closures and the warnings listings, each once. */
    closures: number;
    /** Closures of a junction's on- or off-ramp only (`CLOSURE_ENTRY_EXIT`): not the road. */
    rampClosures: number;
    roadworks: number;
    /** Items the API marks as planned (`future: true`). */
    planned: number;
  };
  /**
   * Not planned, and the road is shut or blocked: every carriageway closure (`CLOSURE`, whatever
   * words its description uses: real ones name the cause, "Ersatzneubau …", or say "Sperrung"),
   * an item the API marks `isBlocked`, and a roadworks item whose description says the road is
   * shut (`Vollsperrung`, the carriageway closed; not a lane, a car park or a rest area). Its window may still lie ahead (a long roadworks phase often names a
   * closure on later days): the description says when.
   */
  blocking: CheckedItem[];
  /** Warnings about an accident, a wrong-way driver or a hazard, whatever their delay. */
  hazards: CheckedItem[];
  /** The other warnings with a delay, the longest first (at most 5). */
  worstDelays: CheckedItem[];
  /** What the data can't say, for the reader. */
  notes: string[];
}

/**
 * Whether a roadworks description says the road is shut: a line with a full closure, no through
 * traffic, all lanes or the carriageway (`Fahrbahn`, `Richtungsfahrbahn`) closed. Not a lane
 * (`Fahrstreifen`), a car park or a rest area, and not a negation ("nicht gesperrt", "keine
 * Vollsperrung"): a long project's last line often names a closure of something else.
 */
function saysRoadIsShut(description: string): boolean {
  return description.split("\n").some((line) => {
    if (/\bnicht\s+(?:voll)?gesperrt|\bkeine\s+(?:voll)?sperrung/i.test(line)) return false;
    if (/vollsperrung|keine durchfahrt|alle fahrstreifen\b[^.;]*\bgesperrt/i.test(line)) return true;
    if (/fahrstreifen|\bspur/i.test(line)) return false;
    return /\b(?:richtungs)?fahrbahn(?:en)?\b[^.;]*\bgesperrt|\bgesperrten?\b[^.;]*\b(?:richtungs)?fahrbahn\b|\bsperrung\s+der\s+(?:richtungs)?fahrbahn\b/i.test(line);
  });
}

const HAZARD = /unfall|falschfahrer|geisterfahrer|gefahr|gegenst[äa]nde auf der fahrbahn/i;
const TRAFFIC_RANK: Record<string, number> = { QUEUING_TRAFFIC: 3, SLOW_TRAFFIC: 2, UNSPECIFIED_ABNORMAL_TRAFFIC: 1 };

function checked(service: CheckedItem["service"], item: AutobahnServiceItem): CheckedItem {
  const delay = Number(item.delayTimeValue);
  const direction = item.subtitle?.trim();
  return {
    service,
    identifier: item.identifier ?? "",
    title: item.title?.trim() ?? "",
    ...(direction ? { direction } : {}),
    ...(item.display_type ? { displayType: item.display_type } : {}),
    planned: item.future === true,
    ...(item.delayTimeValue != null && item.delayTimeValue !== "" && Number.isFinite(delay) ? { delayMinutes: delay } : {}),
    ...(item.abnormalTrafficType ? { trafficType: item.abnormalTrafficType } : {}),
    description: (item.description ?? []).map((line) => line.trim()).filter((line) => line !== "").join("\n"),
  };
}

/**
 * The disruption picture of one motorway: its warnings, closures and roadworks, classified by
 * what the item is (`display_type`), not by the listing it came from (the warnings listing also
 * carries real-time closures). A carriageway closure (`CLOSURE`) not planned is blocking; ramp
 * closures are counted apart and never make the road read as shut; `isBlocked` is almost never
 * set, so a roadworks item's blocking is also read from its description.
 */
export async function checkRoad(client: AutobahnClient, input: { roadId: string }): Promise<RoadCheck> {
  // An empty listing is checked against the road list: one lookup for the three listings, so a
  // clear road costs four requests, not six.
  let roads: Promise<string[]> | undefined;
  const options = { knownRoads: () => (roads ??= client.roads()) };
  const warnings = await client.warnings.list(input.roadId, options);
  const closures = await client.closures.list(input.roadId, options);
  const roadworks = await client.roadworks.list(input.roadId, options);
  // An item in two listings (a real-time closure in the warnings and the closures listing) is one
  // item: the first kept, so it is counted and listed once.
  const seen = new Set<string>();
  const from = (service: CheckedItem["service"], items: AutobahnServiceItem[]) => items.map((item) => [service, item] as const);
  const listed = [...from("warnings", warnings), ...from("closures", closures), ...from("roadworks", roadworks)].filter(([, item]) => {
    const id = item.identifier ?? "";
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const all = listed.map(([service, item]) => checked(service, item));
  const raw = listed.map(([, item]) => item);
  const isClosure = (item: CheckedItem): boolean => item.displayType === "CLOSURE";
  const isRamp = (item: CheckedItem): boolean => item.displayType === "CLOSURE_ENTRY_EXIT";
  const blocking = all.filter((item, i) => {
    if (item.planned || isRamp(item)) return false;
    if (raw[i]?.isBlocked === "true" || isClosure(item)) return true;
    return item.service === "roadworks" && saysRoadIsShut(item.description);
  });
  const hazards = all.filter((item) => item.service === "warnings" && !isClosure(item) && HAZARD.test(item.description) && !blocking.includes(item));
  const worstDelays = all
    .filter((item) => item.service === "warnings" && !isClosure(item) && !hazards.includes(item) && !blocking.includes(item) && (item.delayMinutes ?? 0) > 0)
    .sort((a, b) => (b.delayMinutes ?? 0) - (a.delayMinutes ?? 0) || (TRAFFIC_RANK[b.trafficType ?? ""] ?? 0) - (TRAFFIC_RANK[a.trafficType ?? ""] ?? 0))
    .slice(0, 5);
  return {
    roadId: input.roadId.trim(),
    counts: {
      warnings: all.filter((item) => item.service === "warnings" && !isClosure(item)).length,
      closures: all.filter(isClosure).length,
      rampClosures: all.filter(isRamp).length,
      roadworks: all.filter((item) => item.service === "roadworks").length,
      planned: all.filter((item) => item.planned).length,
    },
    blocking,
    hazards,
    worstDelays,
    notes: [
      "planned: true means upcoming; planned: false is not proof that an item is active now: the time window is in its description (German local time).",
      "A road's listing also carries items of other motorways where they meet: label them by the road their title names.",
      "Roadworks are a count; most are planned or don't block. routeRecommendation (detours) is empty in practice.",
    ],
  };
}

/** One charging site along a motorway. */
export interface ChargingSite {
  identifier: string;
  /** The site's name (the title's last part). */
  name: string;
  /** The next destination in the direction of travel, when the title names one (never `undefined`). */
  towards?: string;
  /** [latitude, longitude], when the site has a usable position. */
  position?: [number, number];
  /** The number of charging points, when the description states it. */
  points?: number;
  /** The highest power in kW the description states (`200+kW` reads as 200). */
  maxKw?: number;
  connectors: string[];
  /** The operator, only Deutschlandnetz sites state one. */
  operator?: string;
  /** Part of the Deutschlandnetz (a numeric identifier). */
  deutschlandnetz: boolean;
}

/** The answer of {@link findChargingStations}. */
export interface ChargingStations {
  roadId: string;
  /** How many sites the road has before the power filter. */
  total: number;
  /** The sites in road order (along the axis the positions spread most), then those without a position. */
  stations: ChargingSite[];
  /** The axis the sites are ordered along: `latitude` (a north-south road, north first) or `longitude` (west first). */
  orderedBy: "latitude" | "longitude";
  /** Sites without a usable position, at the end, unordered. */
  withoutPosition: number;
}

/** A coordinate value as a number: a number, or a string that isn't blank; anything else (`""`, null) NaN, never 0. */
function coordinateNumber(value: unknown): number {
  if (typeof value === "number") return value;
  return typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
}

/**
 * [lat, long] as numbers from either coordinate shape (strings, or a GeoJSON Point), or undefined
 * when either is missing, blank, null or not a number (a blank one is no position, not 0).
 */
export function latLong(coordinate: Coordinate | undefined): [number, number] | undefined {
  if (coordinate === undefined || coordinate === null) return undefined;
  const pair: [number, number] =
    "type" in coordinate && coordinate.type === "Point" && Array.isArray(coordinate.coordinates)
      ? [coordinateNumber(coordinate.coordinates[1]), coordinateNumber(coordinate.coordinates[0])]
      : [coordinateNumber((coordinate as { lat?: unknown }).lat), coordinateNumber((coordinate as { long?: unknown }).long)];
  return pair.every(Number.isFinite) ? pair : undefined;
}

function site(item: AutobahnServiceItem): ChargingSite {
  const identifier = item.identifier ?? "";
  const parts = (item.title ?? "").split("|").map((part) => part.trim());
  const towards = parts.length >= 3 ? parts[1] : undefined;
  const lines = (item.description ?? []).map((line) => line.trim()).filter((line) => line !== "");
  const kw = lines.flatMap((line) => [...line.matchAll(/(\d+(?:[.,]\d+)?)\s*\+?\s*kW/gi)].map((m) => Number((m[1] ?? "").replace(",", "."))));
  const pointBlocks = lines.filter((line) => /^Ladepunkt \d+:?$/i.test(line)).length;
  const pointCount = lines.map((line) => line.match(/^(\d+) Ladepunkte?$/i)?.[1]).find((n) => n !== undefined);
  const connectors = [...new Set(lines.filter((line) => /kupplung|stecker|schuko/i.test(line)).flatMap((line) => line.split(",").map((c) => c.trim())))];
  const operator = lines.map((line) => line.match(/^Ladesäulenbetreiber:\s*(.+)$/i)?.[1]).find((o) => o !== undefined);
  const position = latLong(item.coordinate);
  const points = pointCount !== undefined ? Number(pointCount) : pointBlocks > 0 ? pointBlocks : undefined;
  return {
    identifier,
    name: parts[parts.length - 1] ?? "",
    ...(towards && towards.toLowerCase() !== "undefined" ? { towards } : {}),
    ...(position ? { position } : {}),
    ...(points !== undefined ? { points } : {}),
    ...(kw.length > 0 ? { maxKw: Math.max(...kw) } : {}),
    connectors,
    ...(operator ? { operator } : {}),
    deutschlandnetz: /^\d+$/.test(identifier),
  };
}

/**
 * The charging sites along one motorway, in road order: positions read from both coordinate
 * shapes (Deutschlandnetz sites have a GeoJSON Point and no `lat`/`long`), power, points and
 * connectors parsed from the description (`display_type` is no speed signal), the direction
 * from the title (never the literal `undefined` some sites send). `minKw` keeps the sites whose
 * best point reaches it.
 */
export async function findChargingStations(client: AutobahnClient, input: { roadId: string; minKw?: number | undefined }): Promise<ChargingStations> {
  const all = (await client.chargingStations.list(input.roadId)).map(site);
  const kept = input.minKw === undefined ? all : all.filter((s) => (s.maxKw ?? 0) >= (input.minKw as number));
  const placed = kept.filter((s) => s.position !== undefined);
  const spread = (axis: 0 | 1): number => {
    const values = placed.map((s) => (s.position as [number, number])[axis]);
    return values.length === 0 ? 0 : Math.max(...values) - Math.min(...values);
  };
  const byLatitude = spread(0) >= spread(1);
  placed.sort((a, b) => {
    const [pa, pb] = [a.position as [number, number], b.position as [number, number]];
    return byLatitude ? pb[0] - pa[0] : pa[1] - pb[1];
  });
  const unplaced = kept.filter((s) => s.position === undefined);
  return {
    roadId: input.roadId.trim(),
    total: all.length,
    stations: [...placed, ...unplaced],
    orderedBy: byLatitude ? "latitude" : "longitude",
    withoutPosition: unplaced.length,
  };
}
