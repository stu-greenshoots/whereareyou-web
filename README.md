# whereareyou-web

**Share screen and dispatcher console for the
[whereareyou](https://github.com/stu-greenshoots/whereareyou-protocol) location
handover protocol.**

> ⚠️ Early prototype. Not connected to any emergency service — for a real
> emergency, dial 999.

## Run it

Needs [`whereareyou-api`](https://github.com/stu-greenshoots/whereareyou-api)
running on `:8787`. The dev server proxies `/v1` to it.

```bash
npm install
npm run dev
```

- **Share screen** → https://localhost:5173
- **Dispatcher console** → https://localhost:5173/resolve

### On your phone

The dev server prints a LAN address on startup. Open it, accept the certificate
warning once, and it works.

Two things make the HTTPS necessary rather than optional:

- **Geolocation refuses to run outside a secure context.** `localhost` is
  exempt; a LAN address is not. Over plain HTTP the page loads and then silently
  never returns a fix.
- **Mixed content.** An HTTPS page calling an HTTP API is blocked, so `/v1` is
  proxied through the dev server. This removes CORS from the picture too.

A phone gives a much better demo than a laptop: laptops have no GPS radio and
geolocate from surrounding WiFi at 20–50m, while a phone outdoors gets a real
satellite fix at 5–15m.

## The two surfaces

**Share screen** — one button. Gets a fix, mints a code, and presents it as an
issued document with the phonetic rendering directly under each character.
Supports third-party reports (a location you are *not* standing at), live
sessions that keep updating, and always shows fallback coordinates: offline
code, lat/lon, Plus Code, OS grid reference.

**Dispatcher console** — one input accepting either code type, routed by length.
Map with accuracy circle, all coordinate formats, copy-for-CAD, and a
client-only shift history.

## Design decisions

**Light by default on the public app.** Emergencies happen outdoors in daylight,
where dark-on-light at full brightness is the most legible thing there is. The
console is dark regardless of system preference, like every other tool that
lives on a control room wall.

**The phonetic line is the interface, not a caption.** It is what actually
travels down the phone line, so each word sits under the character it stands
for — when the operator asks "sorry, was that the fifth one?", the caller can
answer without re-reading the whole string.

**Third-party reports never look like the caller's own position.** Different
colour, different badge, explicit banner. A dispatcher confusing "where the
caller is" with "where they say the incident is" is the worst failure this UI
can produce.

**Shift history is client-side only.** A server-side history of resolved
locations is exactly the database this protocol exists to avoid.

**Offline codes resolve with no network call at all.** Stop the API and paste
one in — the position is inside the code.

## Known gaps

Not yet a PWA (no offline app shell), no SSE subscription for live sessions, and
minting still assumes a network — the offline code is shown as a fallback rather
than taking over when there is no signal.

## Licence

MIT.
