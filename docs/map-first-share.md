# The map-first share screen

_Design record, 2026-08-22. Describes what is built and why; the commit
messages carry the finer detail._

The share screen has no start page: it opens straight onto a full-height map
(the header is gone in this mode; the wordmark floats over the tiles) with one
floating button. Everything before a code exists happens over the map; once a
code exists the page becomes the issued document again — before a code exists
the map is the product, after it the code is.

## The pieces

- **Start overlay** — the share button over wide tiles, centred on the last
  shared spot when there is one. Links: report a different location (with
  **place search**, below), look up a code, and the past-shares list.
- **Located sheet** — two rows: the fix-quality line beside two 44px icons
  (gear = options; no-signal glyph = fallback formats), then the mint button.
  One panel open at a time; the open panel scrolls internally so the mint
  button never leaves the screen. **No connection forces the fallback panel
  open** — the offline code and raw formats ARE the product then.
- **Options** — how long the code lasts (30 min–4 h, server-clamped), a name
  for the share, the note for the operator. The name is device-local; the
  note is what the dispatcher sees.
- **Drawing** — toggle-pencil toolbar (single row; the ink palette pops
  upward), full-screen mode for a bigger canvas.
- **Back button drives the UI**: an open panel closes first, then the located
  map steps back to the start screen, and full-screen maps close on Back —
  panels, pills and Escape all go through one history pop. (Side effects must
  stay out of React state updaters here: StrictMode runs updaters twice, and
  a doubled `history.back()` was a real shipped bug.)

## Place search (report-somewhere-else only)

OSM Nominatim, no key, fires **on submit only** — never per keystroke — well
inside the public instance's policy. It renders only in the deliberate
look-a-place-up flow, with a connection: nothing typed about your own position
ever leaves the device. Result accuracy is half the bounding-box diagonal,
capped at ±300 m — a town is not a pin-point. Picking a result names the
share if it was unnamed.

## What the device stores (and nothing else, and nowhere else)

`localStorage`, all clearable in the UI, none of it ever sent anywhere:

| Key | What |
|---|---|
| `activeShare` | The one currently-running session — code, update token, expiry, mode, position, the owner's encoded drawing and their marked spot + icon — so a reload resumes ownership (and everything drawn/marked) via the start screen's chip. Cleared on revoke; ignored once expired. |
| `shareHistory` | Up to 8 past shares — position, name, note, encoded sketch, when. Tapping one re-enters the located screen preloaded; the caller still presses the button themselves. "Clear this list" sits beside it. |
| `resolverKey` (sessionStorage) | The console's API key field. |

## Benched, deliberately

- **"Keep updating my position" (live mode)** — implemented, never verified
  end to end, so the toggle is hidden. Before un-benching: a real walk-around
  test through a live session (mint → move → dispatcher sees the pin move).
- **"This is not where I am" toggle** — redundant with the start screen's
  report-a-different-location flow; hidden.

## Known minor quirks

- After minting, the history entries pushed by the pre-mint UI remain below
  the current entry, so on the code screen the first press or two of Back are
  visual no-ops before leaving the app.
- The one-tap lookup link (`lookup?code=...`) resolves on arrival, which
  claims the session under the shared demo key — intended for the
  send-to-a-friend case; a real control-room deployment would have its own
  keys and claim semantics anyway.


## Live sessions (added 22 Aug, evening)

A live session is a room. The design and deferred-security register live in
`whereareyou-protocol/docs/specs/live-sessions-build-plan.md`; the shipped
shape, briefly: join prompt on the one-tap link (share or just watch — the
two buttons are the consent surface), one session-map screen for owner and
joiners, slate initial-dots for people, initialled/iconed diamonds for
marked spots, per-participant drawings, reconnection with replay, and the
owner present in the room whenever their code screen is open (headless
socket, which is also the single writer of owner state to the store). Marker
moves in the room are tool-only; on the share screen a plain tap marks the
spot — the pin is a person and taps never move people.
