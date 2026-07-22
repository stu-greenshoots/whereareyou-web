# whereareyou-web

**Share screen and look-up console for the
whereareyou location handover protocol.**

> ⚠️ Early prototype. Not connected to any emergency service — for a real
> emergency, dial 999.

## Run it

Needs the whereareyou resolver API running on `:8787`. The dev server proxies `/v1` to it.

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

**With no signal, the offline code becomes the hero rather than the fallback.**
Minting a session code needs a network; encoding an offline one does not. When
the network is gone the offline code gets the full document treatment — same
frame, same size, same phonetic grid — because at that moment it is not a
consolation prize, it is the product.

**A permanent code is never styled like an expiring one.** An offline code
carries no expiry, no revocation and no provenance, so it gets indigo and the
words "does not expire" where a session code gets a countdown. Letting someone
believe their location stops being findable when it never does would be a lie
about their own privacy, told by us.

**Connectivity is evidence, not a flag.** `navigator.onLine` describes the link,
not whether anything is reachable, and it is wrong constantly — captive-portal
wifi being the everyday case. It is trusted in one direction only (when it says
"offline" the link really is down); otherwise the answer comes from requests
that were actually made, plus a background probe of the resolver that runs
whenever reachability is still unproven — which is what decides the
captive-portal case the browser cannot.

**Coming back online never swaps the code underneath the caller.** By then they
may have read the offline code down the phone. A session code is *offered*, and
if they take it the screen keeps saying that the code they already spoke aloud
still works and still never expires.

## Known gaps

No SSE subscription for live sessions yet.

## Licence

MIT.
