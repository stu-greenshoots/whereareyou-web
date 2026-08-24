/**
 * THE SHARING SWITCH — "am I broadcasting my position right now?"
 *
 * One control, two homes: the code screen (where the owner's headless
 * connection does the streaming) and the live bar (where anyone in the room,
 * owner or joiner, can change their mind). It lived as two copies of the same
 * markup until they started to drift; it is one component now.
 *
 * It is a real SWITCH, not a button that happens to have a state:
 * `role="switch"` with `aria-checked`, so a screen reader announces "on" and
 * "off" rather than "pressed", and a physical track-and-knob so the state is
 * readable without reading a word. The knob is square-cornered on purpose —
 * this system's corners are 4px and nothing here is pill-shaped; an iOS-style
 * lozenge would read as a consumer app, which this must not.
 *
 * Green is the on colour because green means exactly one thing in this
 * system — a live session still updating — and that is precisely what this
 * switch controls. Off is the plain surface, never red: choosing not to
 * broadcast is a normal, safe choice, not an error state.
 */
export function ShareSwitch({
  on,
  onChange,
  className = '',
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  /** Extra classes from the surface — the live bar makes it a full row. */
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={`button share-switch ${on ? 'share-switch-on' : ''} ${className}`.trim()}
      onClick={() => onChange(!on)}
    >
      <span className="share-switch-text">
        <span className="share-switch-label">Sharing my location</span>
        {/* The word AND the track: the state is said out loud as well as
            drawn, because a lone knob is a puzzle in bright sun on a cracked
            screen, and this is the one control here with a consequence. */}
        <span className="share-switch-state">
          {on ? (
            <>
              <span className="live-dot" />
              On
            </>
          ) : (
            'Off'
          )}
        </span>
      </span>
      <span className="share-switch-track" aria-hidden="true">
        <span className="share-switch-knob" />
      </span>
    </button>
  );
}
