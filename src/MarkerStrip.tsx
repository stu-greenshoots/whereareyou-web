import { useState } from 'react';
import type { ReactNode } from 'react';
import { MAX_MARKER_NAME_CHARS } from '@whereareyou/protocol';
import type { MarkerIcon } from '@whereareyou/protocol';
import { MARKER_GLYPHS, MarkerIconPicker } from './Map.jsx';
import { PlaceSearch } from './PlaceSearch.jsx';

/**
 * The slim strip that follows a placed point — ONE row: icon chip, name,
 * Done. This replaced the tall place-a-spot sheet (search row + icon grid +
 * name + buttons all at once), which was dense enough to lose someone
 * mid-crisis.
 *
 * While this strip is open the marker is IN EDIT MODE: every map tap moves
 * it to the tapped point (the parent wires that), repeatedly, until Done
 * commits and closes the strip. Tapping a placed marker later reopens the
 * strip in the same mode — one mode, entered from either end. Everything
 * else is progressive disclosure — the icon grid folds behind the chip, the
 * place search behind a glyph — and each expands ABOVE the strip so the row
 * itself never grows. Every surface that places markers mounts this same
 * strip: the share screen (self and report-elsewhere) and the live room
 * (owner and joiner).
 *
 * A search pick moves THE MARKER, never the map — the off-screen edge pills
 * point at a marker that lands out of view, which is exactly what they are
 * for. Removal and "open in maps" are edit-time actions, so they live in the
 * expanded icon panel rather than costing the default flow a button.
 */
export function MarkerStrip({
  icon,
  name,
  onPickIcon,
  onNameChange,
  onDone,
  onRemove,
  onSearchPick,
  searchFailText,
  searchEmptyText,
  extraAction,
}: {
  icon: MarkerIcon;
  name: string;
  onPickIcon: (icon: MarkerIcon) => void;
  onNameChange: (value: string) => void;
  onDone: () => void;
  onRemove: () => void;
  /** Left undefined while offline — the search glyph disappears with it,
      because a field that cannot answer is worse than none. */
  onSearchPick?: ((lat: number, lon: number, accuracyM: number, label: string) => void) | undefined;
  searchFailText: string;
  searchEmptyText: string;
  /** A quiet extra action for the expanded panel — "open in maps" when the
      strip is revisiting a marker on the live map. */
  extraAction?: ReactNode;
}) {
  const [expanded, setExpanded] = useState<'none' | 'icons' | 'search'>('none');

  return (
    <div className="map-sheet marker-strip-sheet">
      {expanded === 'icons' && (
        <div className="marker-strip-pop">
          <MarkerIconPicker
            current={icon}
            onPick={(picked) => {
              onPickIcon(picked);
              setExpanded('none');
            }}
          />
          <div className="marker-strip-pop-row">
            {extraAction}
            <button type="button" className="link-button marker-strip-remove" onClick={onRemove}>
              Remove this spot
            </button>
          </div>
        </div>
      )}

      {expanded === 'search' && onSearchPick !== undefined && (
        <div className="marker-strip-pop">
          <PlaceSearch
            onPick={(lat, lon, accuracyM, label) => {
              setExpanded('none');
              onSearchPick(lat, lon, accuracyM, label);
            }}
            failText={searchFailText}
            emptyText={searchEmptyText}
          />
        </div>
      )}

      <div className="marker-strip">
        <button
          type="button"
          className={`sheet-icon marker-strip-chip ${expanded === 'icons' ? 'sheet-icon-active' : ''}`}
          aria-label="Change what this spot is"
          aria-expanded={expanded === 'icons'}
          title="Change what this spot is"
          onClick={() => setExpanded((current) => (current === 'icons' ? 'none' : 'icons'))}
          dangerouslySetInnerHTML={{ __html: MARKER_GLYPHS[icon] }}
        />
        <input
          className="note-input marker-strip-name"
          placeholder="Name (optional)"
          aria-label="Name this spot"
          maxLength={MAX_MARKER_NAME_CHARS}
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
        />
        {onSearchPick !== undefined && (
          <button
            type="button"
            className={`sheet-icon ${expanded === 'search' ? 'sheet-icon-active' : ''}`}
            aria-label="Search for a place to move this spot to"
            aria-expanded={expanded === 'search'}
            title="Search for a place"
            onClick={() => setExpanded((current) => (current === 'search' ? 'none' : 'search'))}
          >
            <SearchIcon />
          </button>
        )}
        <button type="button" className="button button-primary marker-strip-done" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

/**
 * The strip's PRE-PLACEMENT state: the point tool is armed but nothing is
 * placed yet. Same slim row, but with no marker there is nothing for the
 * icon chip or name to describe — the row carries the one-line hint and,
 * crucially, the place search, so searching can come BEFORE the first tap:
 * a pick PLACES the marker (there is nothing to move yet) and the parent
 * hands over to the edit strip above. Done with nothing placed just closes
 * — the way out for someone who armed the tool and changed their mind.
 */
export function MarkerPlaceStrip({
  hint,
  onSearchPick,
  searchFailText,
  searchEmptyText,
  onDone,
}: {
  /** The one-line way forward, per surface: tap the map, or search. */
  hint: string;
  /** Left undefined while offline — same rule as the edit strip: a field
      that cannot answer is worse than none. A pick PLACES the marker. */
  onSearchPick?: ((lat: number, lon: number, accuracyM: number, label: string) => void) | undefined;
  searchFailText: string;
  searchEmptyText: string;
  onDone: () => void;
}) {
  const [searchOpen, setSearchOpen] = useState(false);

  return (
    <div className="map-sheet marker-strip-sheet">
      {searchOpen && onSearchPick !== undefined && (
        <div className="marker-strip-pop">
          <PlaceSearch
            onPick={(lat, lon, accuracyM, label) => {
              setSearchOpen(false);
              onSearchPick(lat, lon, accuracyM, label);
            }}
            failText={searchFailText}
            emptyText={searchEmptyText}
          />
        </div>
      )}

      <div className="marker-strip">
        <p className="marker-strip-hint">{hint}</p>
        {onSearchPick !== undefined && (
          <button
            type="button"
            className={`sheet-icon ${searchOpen ? 'sheet-icon-active' : ''}`}
            aria-label="Search for a place to mark"
            aria-expanded={searchOpen}
            title="Search for a place"
            onClick={() => setSearchOpen((open) => !open)}
          >
            <SearchIcon />
          </button>
        )}
        <button type="button" className="button button-primary marker-strip-done" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

/** A plain magnifier — geometric strokes in currentColor, like every other
    functional glyph on the map chrome. */
function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <line
        x1="15.4"
        y1="15.4"
        x2="21"
        y2="21"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}
