/** The pulse locator, sized to stand in for the lowercase 'o' in the wordmark. */
function PulseGlyph() {
  return (
    <svg className="pulse-glyph" viewBox="0 0 100 100" aria-hidden="true">
      <circle cx="50" cy="50" r="44" fill="none" stroke="currentColor" strokeWidth="8" opacity="0.3" />
      <circle cx="50" cy="50" r="29" fill="none" stroke="currentColor" strokeWidth="10" opacity="0.62" />
      <circle cx="50" cy="50" r="14" fill="currentColor" />
    </svg>
  );
}

/**
 * Locator-o wordmark: the 'o' in "you" is the pulse mark, so the logo and the
 * app icon are literally the same object. One component, used by the header
 * and floated over the map-first share screen.
 */
export function Brand() {
  return (
    <span className="brand-word" aria-hidden="true">
      wherearey<span className="brand-o"><PulseGlyph /></span>u
    </span>
  );
}
