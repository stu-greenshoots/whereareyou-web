import { useState } from 'react';

/**
 * Place search, via OSM's Nominatim (the same ecosystem as the tiles; no key
 * needed). Search fires ONLY on submit — never per keystroke — which keeps us
 * far inside the public instance's usage policy. The typed query does leave
 * the device, so this renders only when the caller is deliberately looking a
 * place up, never for their own position — and every surface that mounts it
 * withholds it while offline rather than offering a field that cannot answer.
 *
 * Started life inside the report-somewhere-else flow, then fronted every
 * marker placement. It does neither now: it is the field inside the map's
 * own search control (see Map.tsx), where a pick moves the VIEW and marks
 * nothing. The two fallback lines stay per-caller so whoever mounts it can
 * say what its own way forward is.
 */
export function PlaceSearch({
  onPick,
  failText = 'Search did not respond — you can still drag the pin instead.',
  emptyText = 'Nothing found for that. Try adding a town, or drag the pin.',
}: {
  onPick: (lat: number, lon: number, accuracyM: number, label: string) => void;
  /** Shown when the search request itself failed. Names this surface's way
      forward — a search that dies must never read as a dead end. */
  failText?: string;
  /** Shown when the search answered with nothing. Same rule. */
  emptyText?: string;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Array<{
    lat: number;
    lon: number;
    accuracyM: number;
    label: string;
  }> | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * How the last attempt went wrong, if it did. Told apart on purpose: a
   * search that could not leave the device is a different fact from one the
   * server refused, and only one of them is worth waiting for signal over.
   */
  const [failed, setFailed] = useState<'none' | 'network' | 'offline'>('none');

  const run = async () => {
    const q = query.trim();
    if (q === '' || busy) return;
    // A device that knows it is offline should say so rather than spending
    // several seconds failing at it. Only trusted in the negative —
    // navigator.onLine says nothing useful when it is true.
    if (navigator.onLine === false) {
      setFailed('offline');
      setResults(null);
      return;
    }
    setBusy(true);
    setFailed('none');
    try {
      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(q)}`,
        { headers: { Accept: 'application/json' } },
      );
      if (!response.ok) throw new Error(String(response.status));
      const data = (await response.json()) as Array<{
        lat: string;
        lon: string;
        display_name: string;
        boundingbox?: [string, string, string, string];
      }>;
      setResults(
        data.map((place) => {
          const lat = Number(place.lat);
          const lon = Number(place.lon);
          // Honest precision: half the result's bounding-box diagonal. A
          // named building is tens of metres; a whole town caps at ±300m
          // rather than pretending to a pin-point.
          let accuracyM = 50;
          if (place.boundingbox !== undefined) {
            const [south, north, west, east] = place.boundingbox.map(Number) as [number, number, number, number];
            const northM = (north - south) * 111_320;
            const eastM = (east - west) * 111_320 * Math.cos((lat * Math.PI) / 180);
            accuracyM = Math.round(Math.min(300, Math.max(10, Math.hypot(northM, eastM) / 2)));
          }
          return { lat, lon, accuracyM, label: place.display_name };
        }),
      );
    } catch {
      setFailed('network');
      setResults(null);
    }
    setBusy(false);
  };

  return (
    <div className="place-search">
      <form
        className="place-search-row"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <input
          className="note-input place-search-input"
          type="search"
          aria-label="Search for a place"
          placeholder="Street, town or postcode"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            // Editing the query retires the last answer: a stale "nothing
            // found" sitting under a half-typed new one is a lie about what
            // was asked.
            if (failed !== 'none') setFailed('none');
          }}
        />
        <button
          type="submit"
          className="button button-primary place-search-go"
          disabled={busy || query.trim() === ''}
        >
          {busy ? 'Searching…' : 'Search'}
        </button>
      </form>

      {/* Every failure carries its own way forward — the map is still there
          to be panned and zoomed by hand, whatever the search did. */}
      {failed === 'network' && <p className="place-search-msg place-search-msg-bad">{failText}</p>}
      {failed === 'offline' && (
        <p className="place-search-msg place-search-msg-offline">
          No signal, so this cannot look anywhere up. You can still pan and zoom the map yourself.
        </p>
      )}
      {results !== null && results.length === 0 && (
        <p className="place-search-msg">{emptyText}</p>
      )}
      {results !== null && results.length > 0 && (
        <div className="place-results" role="list">
          {results.map((place) => {
            const head = place.label.split(',')[0] ?? place.label;
            const rest = place.label.split(',').slice(1).join(',').trim();
            return (
              <button
                key={`${place.lat},${place.lon}`}
                type="button"
                role="listitem"
                className="place-result"
                onClick={() => {
                  setResults(null);
                  onPick(place.lat, place.lon, place.accuracyM, place.label);
                }}
              >
                <span className="place-result-name">{head}</span>
                {rest !== '' && <span className="place-result-where">{rest}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** The place's own short name — the bit before Nominatim's first comma —
    trimmed to fit wherever it is being said back ("Moved to …"). */
export function placeShortName(label: string, maxChars: number): string {
  return (label.split(',')[0] ?? '').trim().slice(0, maxChars);
}
