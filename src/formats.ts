import olc from 'open-location-code';
import { LatLon } from 'geodesy/osgridref.js';

const openLocationCode = new olc.OpenLocationCode();

/**
 * Decimal places for displayed lat/lon.
 *
 * 5dp is ~1.1m, which sits comfortably inside a 3m grid square and is also
 * about the honest precision floor of a consumer GNSS fix. 4dp would be ~11m —
 * coarser than the thing we are trying to beat. More than 6 would be
 * fabricating precision the handset never had.
 */
export const COORD_DP = 5;

export function formatLatLon(lat: number, lon: number): string {
  return `${lat.toFixed(COORD_DP)}, ${lon.toFixed(COORD_DP)}`;
}

/** Plus Code (Open Location Code) at ~3m resolution. */
export function toPlusCode(lat: number, lon: number): string | null {
  try {
    return openLocationCode.encode(lat, lon, 11);
  } catch {
    return null;
  }
}

/**
 * Rough bounding box for the OSGB36 grid. Outside this the conversion is
 * meaningless, so we simply do not offer it rather than showing a wrong answer.
 */
function withinGreatBritain(lat: number, lon: number): boolean {
  return lat >= 49.8 && lat <= 61.0 && lon >= -8.7 && lon <= 1.9;
}

/** Ordnance Survey grid reference, GB only. */
export function toOsGridRef(lat: number, lon: number): string | null {
  if (!withinGreatBritain(lat, lon)) return null;
  try {
    return new LatLon(lat, lon).toOsGrid().toString();
  } catch {
    return null;
  }
}

/** Everything a dispatcher might need to read or paste, in one shape. */
export interface CoordinateFormats {
  latLon: string;
  plusCode: string | null;
  osGridRef: string | null;
  googleMapsUrl: string;
  osMapsUrl: string | null;
}

export function allFormats(lat: number, lon: number): CoordinateFormats {
  const osGridRef = toOsGridRef(lat, lon);
  return {
    latLon: formatLatLon(lat, lon),
    plusCode: toPlusCode(lat, lon),
    osGridRef,
    googleMapsUrl: `https://www.google.com/maps?q=${lat.toFixed(COORD_DP)},${lon.toFixed(COORD_DP)}`,
    osMapsUrl: osGridRef
      ? `https://osmaps.com/map?lat=${lat.toFixed(COORD_DP)}&lon=${lon.toFixed(COORD_DP)}&zoom=16`
      : null,
  };
}

/** Human-readable time remaining, e.g. "28m 04s". */
export function timeRemaining(expiresAt: string, now = Date.now()): string {
  const remainingMs = Date.parse(expiresAt) - now;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return 'expired';
  const totalSeconds = Math.floor(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
  }
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/**
 * Accuracy at or below this is treated as satellite-derived.
 *
 * The browser Geolocation API never tells us which sensor produced a fix, so
 * this is an inference from the accuracy radius alone. WiFi trilateration
 * realistically bottoms out around 20–30m; a tighter figure than that
 * effectively has to be GNSS. The threshold is deliberately conservative —
 * mislabelling a WiFi fix as GPS would inflate a dispatcher's confidence in a
 * position, which is the more dangerous direction to be wrong in.
 */
export const GNSS_ACCURACY_THRESHOLD_M = 20;

/** Best guess at the sensor behind a browser fix. See threshold note above. */
export function inferSource(accuracyM: number): 'gnss' | 'network' {
  return accuracyM <= GNSS_ACCURACY_THRESHOLD_M ? 'gnss' : 'network';
}

/**
 * How much to trust an accuracy figure, given where the fix came from.
 *
 * Wording is hedged for device fixes because the source is inferred, not
 * reported. Telling a dispatcher "GPS fix" when we are guessing would be
 * asserting a confidence we do not have.
 */
export function describeSource(source: string, accuracyM: number): string {
  const rounded = Math.round(accuracyM);
  switch (source) {
    case 'gnss':
      return `Satellite-grade fix, ±${rounded}m`;
    case 'network':
      return `WiFi or network fix, ±${rounded}m — approximate, likely a laptop or indoors`;
    case 'manual':
      return `Placed by hand, sharer estimated ±${rounded}m`;
    default:
      return `±${rounded}m`;
  }
}
