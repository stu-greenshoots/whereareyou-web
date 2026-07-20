# Claude Design prompts — whereareyou

Paste these into claude.ai/design in order. Each builds on the last.

**Before you start:** create a *new* design-system project rather than working in
"OpenDialog Design System". Sofia Pro is commercially licensed to OpenDialog and
cannot ship in an open-source repo, and the OpenDialog palette carries a
different product's identity.

---

## Prompt 1 — Foundations

> I'm designing **whereareyou**, an emergency location tool. Someone in trouble
> presses one button, gets a short code like `X7K9-P2Q4`, and reads it aloud to
> a 999 operator, who types it in and sees exactly where they are.
>
> Build me the foundations of a design system for it: colour, typography,
> spacing, elevation, and interaction states.
>
> **The user context is unusual and should drive every decision:**
> - They may be frightened, injured, or panicking
> - Often one-handed, sometimes in the dark, often in **bright outdoor daylight**
> - Possibly a cracked screen, low battery, poor signal
> - They may never have used it before and will not read instructions
>
> **Two surfaces, deliberately different in character:**
> 1. **Public share screen** — presented like an *issued document*: something
>    official handed to you, not an app screen. **Light by default**, because
>    emergencies happen outdoors where dark-on-light at full brightness is the
>    most legible thing there is. Should follow the system into dark mode at
>    night.
> 2. **Dispatcher console** — a control-room tool. Dark regardless of system
>    preference, denser, faster, unmistakably not the public app. Sits alongside
>    CAD software on a wall of screens.
>
> **Typography — I want to use [Atkinson
> Hyperlegible](https://www.brailleinstitute.org/freefont).** It was designed by
> the Braille Institute to maximise legibility and specifically to disambiguate
> confusable characters — `0`/`O`, `1`/`I`/`l`, `5`/`S`. This app exists because
> characters get misread down phone lines, so the typeface engineered against
> exactly that problem is the right call. Pair it with a monospace that has a
> slashed zero and unmistakable `1`/`l` for the codes themselves — JetBrains
> Mono or IBM Plex Mono.
>
> **Colour must carry information, never decoration.** Three semantic states
> that must be instantly distinguishable and must never be used for anything
> else:
> - **Amber** — a *reported* location. Someone phoning about a fire across the
>   road, not where they are standing.
> - **Green** — a *live* session, position still updating.
> - **Indigo** — an *offline* code, which is a permanent grid reference with no
>   timestamp or expiry.
>
> **Constraints:**
> - WCAG AAA contrast on anything safety-critical; AA minimum everywhere
> - Primary actions need very large touch targets — think 88px tall minimum
> - Must work in direct sunlight and in complete darkness
> - Must feel **trustworthy and calm, not alarming**. Panic amplification is a
>   real failure mode. This is not a warning label.
> - Everything self-hostable. No CDN fonts, no external requests.
>
> **Please avoid:** decorative gradients, playful illustration, anything that
> reads as a consumer app, and small-caps serif labels (I tried Georgia caps and
> it looked cheap and dated rather than institutional).

---

## Prompt 2 — The code document

> Now design the central component: the **code display**.
>
> This is the whole product in one element. A person reads it aloud to an
> emergency operator, so it has two parts that matter equally:
>
> 1. **The code itself** — 8 characters, grouped: `X7K9-P2Q4`. Should dominate
>    the screen. Monospace, tabular, must never wrap mid-string.
> 2. **The phonetic rendering** — `X-ray Seven Kilo Nine Papa Two Quebec Four`.
>
> **The phonetic line is the actual interface, not a caption.** It is what
> literally travels down the phone line. Style it as an instruction to be
> *performed*.
>
> Show each phonetic word **directly beneath the character it stands for**, so
> that when the operator says "sorry, was that the fifth one?", the caller can
> answer by looking rather than counting from the start:
>
> ```
>  X       7       K       9      P      2       Q        4
> X-ray  Seven   Kilo    Nine   Papa   Two   Quebec    Four
> ```
>
> Design these states:
> - **Active** — plenty of time left, calm
> - **Expiring soon** — under 5 minutes, needs urgency without alarm
> - **Expired** — clearly dead, with an obvious route to start again
> - **Claimed** — an operator has looked it up. This is *reassuring* information
>   for someone waiting, so treat it as good news.
> - **Offline variant** — 10 characters (`FTSE-MP0F-1M`), indigo, and must be
>   visibly a *different kind of thing*: permanent, no expiry, no timer.
>
> Also design the countdown treatment. It should be readable at a glance without
> being a threatening ticking clock.

---

## Prompt 3 — Share screen flows

> Design the full public share screen, every state:
>
> 1. **Idle** — one enormous primary button, "Share my location". Plus a quieter
>    secondary route: "Report a different location instead".
> 2. **Locating** — acquiring a GPS fix, needs to feel like progress not a hang
> 3. **Located** — a map with the pin, before committing. Two toggles: *"This is
>    not where I am"* (report elsewhere) and *"Keep updating my position"*
>    (live). Plus an optional free-text note, e.g. "third floor, back stairwell".
> 4. **Shared** — the code document, a share button, and a stop-sharing button
> 5. **Live** — a persistent, unmissable indicator that position is being shared
> 6. **Errors** — permission denied, no fix available, offline. **Every error
>    must offer a way forward**, never a dead end. Permission refused still
>    allows placing a pin manually.
>
> Also design the **fallback panel**, always visible under the code. It carries
> the same location in four formats — offline code, latitude/longitude, Plus
> Code, OS grid reference — each individually copyable. It exists because
> minting a code needs connectivity and coordinates do not; if signal drops, the
> caller must still have something to read aloud. Design it so it is available
> without competing with the code.
>
> No accounts, no onboarding, no cookie banner, no ads, no analytics. A frightened
> person should be able to use this in under five seconds having never seen it.

---

## Prompt 4 — Dispatcher console

> Design the operator-facing console. Dark, dense, professional — this sits
> alongside CAD software on a control room desk while the operator is on a call.
>
> **Code entry.** A single input taking either code type, plus every way a human
> might transcribe it: `X7K9-P2Q4`, `x7k9p2q4`, or the fully spoken `X-ray Seven
> Kilo Nine Papa Two Quebec Four`. It must show live interpretation as they type.
>
> Critically: a **mistyped code is caught by a checksum before submission**. The
> operator must be able to tell *"I typed it wrong"* from *"there is no such
> session"* instantly, without thinking. Those are completely different
> situations and the design has to separate them.
>
> **Result view:**
> - Map with pin and an accuracy circle
> - How much to trust the fix — a satellite fix at ±8m and a WiFi fix at ±8m
>   deserve different confidence, so the source must be visible
> - **A reported (third-party) location must never look like the caller's own
>   position.** An operator confusing "where the caller is" with "where they say
>   the incident is" is the worst failure this interface can produce. This needs
>   the strongest treatment in the whole system.
> - The caller's note, prominently
> - Live sessions: animated pin, breadcrumb trail, "last updated 4s ago" that
>   visibly goes stale if updates stop
> - All coordinate formats, one-click copy, and a "copy for CAD" line
>
> Also design an **offline-code result**, which is a different kind of answer: a
> permanent grid reference with no timestamp, no accuracy reading and no sender.
> It says *where*, and nothing else. It must not be mistaken for a live session.
>
> Finally, a **shift history** — codes resolved this session, held in the browser
> only and never sent to the server.

---

## After designing

Export tokens as CSS custom properties. The current implementation already uses
this shape, so swapping is mostly mechanical:

```css
--bg  --surface  --surface-2  --text  --text-dim
--rule  --rule-soft  --accent  --accent-soft
--third-party  --live  --offline  --danger
--font-ui  --font-mono
```

Two themes are needed: `.theme-public` (light, with a
`prefers-color-scheme: dark` variant) and `.theme-console` (dark always).

I can sync components back down into this repo once you're happy with them.
