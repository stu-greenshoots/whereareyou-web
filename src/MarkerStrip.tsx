import { useState } from 'react';
import type { ReactNode } from 'react';
import { MAX_MARKER_NAME_CHARS } from '@whereareyou/protocol';
import type { MarkerIcon } from '@whereareyou/protocol';
import { ClearIcon, MARKER_GLYPHS, MarkerIconPicker } from './Map.jsx';

/**
 * The slim strip that follows a placed point — ONE row: icon chip, name,
 * Done. This replaced the tall place-a-spot sheet (search row + icon grid +
 * name + buttons all at once), which was dense enough to lose someone
 * mid-crisis.
 *
 * While this strip is open the marker is IN EDIT MODE: every map tap moves
 * it to the tapped point (the parent wires that), repeatedly, until Done
 * commits and closes the strip. Tapping a placed marker later reopens the
 * strip in the same mode — one mode, entered from either end. The icon grid
 * is the one thing still folded behind a chip, and it expands ABOVE the
 * strip so the row itself never grows. Every surface that places markers
 * mounts this same strip: the share screen (self and report-elsewhere) and
 * the live room (owner and joiner).
 *
 * Place search is NOT here. It used to be — a glyph on this row whose pick
 * moved the marker and named it after the place — and it is now a permanent
 * control on the map itself, where a pick moves the VIEW and marks nothing.
 * The strip is for the spot you have already chosen; finding somewhere on
 * the map is a different job and no longer borrows this row to do it.
 *
 * REMOVE IS ON THE DEFAULT ROW. It used to live inside the icon chip's
 * expanded panel — one fold too deep: the owner of this app could not find
 * how to delete a marker on his own live map, which is the whole reason this
 * row changed. It sits at the FAR LEFT, the maximum distance from Done at
 * the far right, because it is the one control here that undoes work; and
 * every surface pairs it with an undo toast, so a mis-tap costs a tap rather
 * than a marker. Cheap-to-undo beats a confirm dialog: a confirm would tax
 * every deliberate removal to guard against a rare accident, in a UI whose
 * users are one-handed and in a hurry. "Open in maps" stays folded behind
 * the chip — it is a way OUT of the app, never a rival to the two things
 * this row is for.
 */
export function MarkerStrip({
  icon,
  name,
  onPickIcon,
  onNameChange,
  onDone,
  onRemove,
  extraAction,
}: {
  icon: MarkerIcon;
  name: string;
  onPickIcon: (icon: MarkerIcon) => void;
  onNameChange: (value: string) => void;
  onDone: () => void;
  onRemove: () => void;
  /** A quiet extra action for the expanded panel — "open in maps" when the
      strip is revisiting a marker on the live map. */
  extraAction?: ReactNode;
}) {
  const [iconsOpen, setIconsOpen] = useState(false);

  return (
    <div className="map-sheet marker-strip-sheet">
      {iconsOpen && (
        <div className="marker-strip-pop">
          <MarkerIconPicker
            current={icon}
            onPick={(picked) => {
              onPickIcon(picked);
              setIconsOpen(false);
            }}
          />
          {extraAction !== undefined && <div className="marker-strip-pop-row">{extraAction}</div>}
        </div>
      )}

      <div className="marker-strip">
        <button
          type="button"
          className="marker-strip-remove"
          aria-label="Remove this spot"
          title="Remove this spot"
          onClick={onRemove}
        >
          <ClearIcon />
        </button>
        <button
          type="button"
          className={`sheet-icon marker-strip-chip ${iconsOpen ? 'sheet-icon-active' : ''}`}
          aria-label="Change what this spot is"
          aria-expanded={iconsOpen}
          title="Change what this spot is"
          onClick={() => setIconsOpen((open) => !open)}
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
 * icon chip or name to describe — so the row carries the one-line hint and
 * Done, and nothing else. Done with nothing placed just closes — the way out
 * for someone who armed the tool and changed their mind.
 *
 * Getting to the right part of the map first is the map's own search
 * control's job, not this row's: it moves the view, and then a tap here
 * marks the spot.
 */
export function MarkerPlaceStrip({ hint, onDone }: {
  /** The one-line way forward, per surface. */
  hint: string;
  onDone: () => void;
}) {
  return (
    <div className="map-sheet marker-strip-sheet">
      <div className="marker-strip">
        <p className="marker-strip-hint">{hint}</p>
        <button type="button" className="button button-primary marker-strip-done" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}
