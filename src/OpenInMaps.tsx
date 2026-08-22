import { COORD_DP } from './formats.js';

/**
 * A link into the device's own maps app, for the moment a handover succeeds
 * and someone actually has to GO there. Apple Maps on Apple touch devices —
 * the one app guaranteed present, and the URL every iOS handler claims —
 * Google Maps' universal search URL everywhere else.
 */
function isApplePlatform(): boolean {
  // iPadOS 13+ reports itself as MacIntel; the touch points tell it apart
  // from an actual Mac, where Apple Maps may not be the right answer.
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

export function openInMapsUrl(lat: number, lon: number, label: string): string {
  const point = `${lat.toFixed(COORD_DP)},${lon.toFixed(COORD_DP)}`;
  return isApplePlatform()
    ? `https://maps.apple.com/?ll=${point}&q=${encodeURIComponent(label)}`
    : `https://www.google.com/maps/search/?api=1&query=${point}`;
}

/**
 * The affordance itself: a quiet link, never competing with the code or the
 * primary actions. `label` names the dropped pin on the other side — the
 * session code, or what the spot is.
 */
export function OpenInMaps({ lat, lon, label }: { lat: number; lon: number; label: string }) {
  return (
    <a
      className="link-button open-in-maps"
      href={openInMapsUrl(lat, lon, label)}
      target="_blank"
      rel="noopener noreferrer"
    >
      Open in maps
    </a>
  );
}
