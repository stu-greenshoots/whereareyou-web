import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  decodeSketch,
  formatCode,
  formatOfflineCode,
  interpretCode,
  type OfflinePosition,
  type SessionMarker,
} from '@whereareyou/protocol';
import { resolveSession, type ResolvedWithWarning } from './api.js';
import { useAccount } from './AccountContext.jsx';
import type { SavedMap } from './account.js';
import { ProfileMenu } from './ProfileMenu.jsx';
import { SaveMapButton } from './SaveMap.jsx';
import { SessionMap, panelFromFragment, type LivePanel } from './SessionMap.jsx';
import { loadActiveShare, loadJoinedIdentity, rememberJoinedIdentity } from './local-session.js';
import { useSharedConnectivity } from './connectivity.js';
import { Map, escapeHtml } from './Map.jsx';
import { OpenInMaps, openInMapsUrl } from './OpenInMaps.jsx';
import { CopyRow } from './CopyRow.jsx';
import { allFormats, describeSource, timeRemaining } from './formats.js';

/** Human-readable explanation of why input was rejected before submission. */
const PARSE_HINTS: Record<string, string> = {
  empty: '',
  unreadable: "That doesn't look like a code.",
  'too-short': 'Keep going — 8 characters for a live code, 10 for an offline one.',
  'too-long': 'That is too long. Live codes are 8 characters, offline codes 10.',
  'bad-checksum': 'That code has a typo — check it with the person who sent it.',
};

interface HistoryEntry {
  code: string;
  at: number;
}

/** Wall-clock for the console's provenance facts. Never relative: an
    operator reading a position back needs a time they can say out loud. */
function clockTime(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime())
    ? 'unknown'
    : parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** An offline code resolved locally, with no server involved. */
interface OfflineResult {
  code: string;
  position: OfflinePosition;
}

/**
 * A key baked into the build so the public demo works without every visitor
 * having to be handed one. It is NOT a secret — it ships in a public bundle and
 * everyone shares it, which means claim-on-read binds every look-up to the same
 * identity and the anti-harvest property is effectively off. That is a
 * deliberate demo trade, not how a real control room would be provisioned, and
 * the field below stays visible and editable so the mechanism is legible.
 */
const DEMO_KEY = import.meta.env['VITE_DEMO_API_KEY'] ?? '';

export function Resolve({ onOpenSavedMap }: { onOpenSavedMap: (map: SavedMap) => void }) {
  const [input, setInput] = useState('');
  const [apiKey, setApiKey] = useState(() => sessionStorage.getItem('resolverKey') ?? DEMO_KEY);
  const [session, setSession] = useState<ResolvedWithWarning | null>(null);
  const [offline, setOffline] = useState<OfflineResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  /** Set when this device has joined the resolved session's live room. */
  const [live, setLive] = useState<{ share: boolean; name: string } | null>(null);
  /** The join/watch choice made, while the what-should-we-call-you sheet is
      up — the one step between choosing to enter and actually entering. */
  const [pendingJoin, setPendingJoin] = useState<'share' | 'watch' | null>(null);
  /** Panel a push deep link asked for (#chat|#activity|#people) — consumed
      by the first session view this visit opens, then forgotten. */
  const [deepPanel, setDeepPanel] = useState<LivePanel | null>(() =>
    panelFromFragment(window.location.hash),
  );
  const { account } = useAccount();
  // The account name is the natural default for who you are in a room.
  const [joinName, setJoinName] = useState(account.name);
  const [, forceTick] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // Tiles are the only thing on this screen that needs the network. Without
  // this, a dispatcher offline sees an unexplained grey box where the map
  // should be — the Share screen already threads connectivity into its <Map>.
  const { online } = useSharedConnectivity();

  useEffect(() => inputRef.current?.focus(), []);

  // A shared link carries its code (?code=...), so the person it was sent to
  // gets the position in one tap with nothing to type. Runs once — lookup is
  // deliberately not re-fired on later re-renders or key changes.
  const autoResolvedRef = useRef(false);
  useEffect(() => {
    if (autoResolvedRef.current) return;
    autoResolvedRef.current = true;
    const fromLink = new URLSearchParams(window.location.search).get('code');
    if (fromLink !== null && fromLink !== '') {
      setInput(fromLink);
      void lookup(fromLink);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (session === null) return;
    const timer = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [session]);

  // Live interpretation as the dispatcher types. Showing the canonical form and
  // flagging a checksum failure *before* submission is what lets them tell
  // "I mistyped it" from "there is no such session" without having to think.
  const parsed = useMemo(() => interpretCode(input), [input]);
  const ready = parsed.kind === 'session' || parsed.kind === 'offline';

  const lookup = useCallback(
    async (rawCode: string) => {
      const candidate = interpretCode(rawCode);

      // An offline code needs no server at all — the position is inside the
      // code. This path works with the API stopped and the network unplugged.
      if (candidate.kind === 'offline') {
        setSession(null);
        setLive(null);
        setPendingJoin(null);
        setError(null);
        setOffline({ code: candidate.code, position: candidate.position });
        setHistory((previous) =>
          [
            { code: candidate.code, at: Date.now() },
            ...previous.filter((entry) => entry.code !== candidate.code),
          ].slice(0, 10),
        );
        return;
      }

      if (candidate.kind !== 'session') return;

      // Self-rejoin guard, local state FIRST: if this code is the share THIS
      // DEVICE currently owns, entering it here must never join our own room
      // as a stranger — route back to the owner code screen instead (the
      // resume flow over there shows a quiet note and takes it from here).
      // Push deep links carry the same shape, so the fragment rides along.
      const own = loadActiveShare();
      if (own !== null && own.code === candidate.code && timeRemaining(own.expiresAt) !== 'expired') {
        window.location.assign(
          `${import.meta.env.BASE_URL}?resume=${candidate.code}${window.location.hash}`,
        );
        return;
      }

      setBusy(true);
      setError(null);
      setOffline(null);
      setLive(null);
      setPendingJoin(null);
      const result = await resolveSession(candidate.code, apiKey || undefined);
      setBusy(false);

      if (!result.ok) {
        setSession(null);
        setError(
          result.error === 'not-found'
            ? 'No live session for that code. It may have expired, been stopped, or already been looked up by someone else.'
            : result.message,
        );
        return;
      }

      setSession(result.data);
      setHistory((previous) =>
        [
          { code: result.data.code, at: Date.now() },
          ...previous.filter((entry) => entry.code !== result.data.code),
        ].slice(0, 10),
      );

      // Self-rejoin guard (b): a live session this device already joined
      // re-enters as the SAME presented identity, straight back into the
      // session view — no second join prompt, no fresh anonymous stranger.
      if (result.data.mode === 'live') {
        const known = loadJoinedIdentity(result.data.code);
        if (known !== null) {
          setJoinName(known.name);
          setLive({ share: known.share, name: known.name });
        }
      }
    },
    [apiKey],
  );

  const submit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      void lookup(input);
    },
    [input, lookup],
  );

  const saveKey = useCallback((value: string) => {
    setApiKey(value);
    sessionStorage.setItem('resolverKey', value);
  }, []);

  /** Join or watch chosen — the name sheet is the one step before entering.
      Pre-filled with whatever we already know: the name typed on an earlier
      visit this session, or the account name. */
  const openNameStep = useCallback(
    (which: 'share' | 'watch') => {
      setJoinName((current) => (current !== '' ? current : account.name));
      setPendingJoin(which);
    },
    [account.name],
  );

  /** Actually enter the room, as the presented identity. An empty name is
      the skip path — anonymous, exactly as before. Remembered per code so
      re-entering resumes as the same person without asking again. */
  const commitJoin = useCallback(
    (share: boolean, rawName: string) => {
      if (session === null) return;
      const name = rawName.trim();
      rememberJoinedIdentity(session.code, { share, name });
      setJoinName(name);
      setPendingJoin(null);
      setLive({ share, name });
    },
    [session],
  );

  // Joined: the room takes the whole screen until they leave. The live
  // session view is a PARTICIPANT surface — someone joining or watching a
  // shared map — so it reads light (Voyager), same as the owner's map
  // ("it's better light" — field report). Dark Matter stays on the static
  // resolved-location panels below: the operator's control-room read. A
  // watcher (share: false — the dispatcher's posture) still gets the
  // read-only chat panel.
  if (session !== null && live !== null) {
    return (
      /* share-stage-account: the floating profile control below claims
         top-right — the same placement discipline as the owner's live map —
         and this class shifts the map's own locate control down a slot so
         the two never overlap. The live bar and compass keep the bottom. */
      <div className="share-stage share-stage-account">
        <SessionMap
          code={session.code}
          displayCode={formatCode(session.code)}
          role="joiner"
          share={live.share}
          /* The switch in the room moved. Remember the posture per code so
             re-entering resumes as whatever they last chose, rather than
             re-asking or quietly reverting to the join-time answer. */
          onSharingChange={(sharing) => {
            setLive((current) => (current === null ? current : { ...current, share: sharing }));
            rememberJoinedIdentity(session.code, { share: sharing, name: live.name });
          }}
          {...(live.name !== '' ? { name: live.name } : {})}
          {...(account.avatar !== null ? { avatar: account.avatar } : {})}
          {...(deepPanel !== null ? { initialPanel: deepPanel } : {})}
          initialPosition={session.position}
          onLeave={() => {
            setLive(null);
            // The deep link is spent — leaving and re-entering by hand must
            // not keep flinging the same panel open.
            setDeepPanel(null);
          }}
        />
        {/* The same floating account control every other map-first screen
            gets — the header is gone while the room fills the screen. */}
        <div className="profile-float">
          <ProfileMenu onOpenSavedMap={onOpenSavedMap} />
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      <form onSubmit={submit} className="resolve-form">
        <label className="field-label" htmlFor="code-input">
          Location code
        </label>
        <input
          id="code-input"
          ref={inputRef}
          className="code-input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="X7K9-P2Q4  ·  FTSE-MP0F-1M  ·  X-ray Seven Kilo Nine…"
          autoComplete="off"
          spellCheck={false}
        />

        <div className="parse-feedback">
          {parsed.kind === 'session' && (
            <span className="parse-session">Live code — reads as {formatCode(parsed.code)}</span>
          )}
          {parsed.kind === 'offline' && (
            <span className="parse-offline">
              Offline code — reads as {formatOfflineCode(parsed.code)}, resolves without a server
            </span>
          )}
          {parsed.kind === 'invalid' && parsed.reason !== 'empty' && (
            <span className="parse-bad">
              {PARSE_HINTS[parsed.reason]}
              {parsed.normalised !== '' && <> Got “{parsed.normalised}”.</>}
            </span>
          )}
        </div>

        {/* Offline, a session look-up cannot succeed — say so instead of
            offering it. Offline codes stay first-class: they resolve
            entirely on this device. */}
        {!online && (
          <p className="offline-gate">
            No connection — session codes need the resolver right now. Offline codes still
            resolve on this device.
          </p>
        )}

        <button
          className="button"
          type="submit"
          disabled={busy || !ready || (!online && parsed.kind === 'session')}
        >
          {busy ? 'Looking up…' : 'Look up'}
        </button>
      </form>

      {error !== null && <div className="notice notice-warn">{error}</div>}

      {session !== null && session.mode === 'live' && pendingJoin === null && (
        <div className="notice notice-live join-prompt">
          <strong>This is a live share — you can join it.</strong>
          <span>
            Joining shares your position and your drawings with everyone in it until you leave.
            Or just watch it move. Either way you can turn sharing on or off once you are in.
          </span>
          <div className="notice-actions">
            <button className="button button-primary" onClick={() => openNameStep('share')}>
              Join and share my location
            </button>
            <button className="button" onClick={() => openNameStep('watch')}>
              Just watch
            </button>
          </div>
        </div>
      )}

      {/* The one step between choosing to enter and entering: a name. The
          identity presented at hello is what chat, the activity feed and the
          joined announcement all show — asked once, remembered per code, and
          always skippable (skip = anonymous, exactly as before). */}
      {session !== null && session.mode === 'live' && pendingJoin !== null && (
        <form
          className="notice notice-live join-prompt"
          onSubmit={(event) => {
            event.preventDefault();
            commitJoin(pendingJoin === 'share', joinName);
          }}
        >
          <strong>What should we call you?</strong>
          <span>
            Your name sits beside your dot and your messages, so everyone knows who is who.
          </span>
          <input
            className="note-input"
            placeholder="Your name"
            value={joinName}
            maxLength={40}
            // The sheet exists to take a name — focusing anything else first
            // would just add a tap for the person it is asking.
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            onChange={(event) => setJoinName(event.target.value)}
          />
          <div className="notice-actions">
            <button className="button button-primary" type="submit">
              {pendingJoin === 'share' ? 'Join' : 'Start watching'}
            </button>
            <button
              className="button"
              type="button"
              onClick={() => commitJoin(pendingJoin === 'share', '')}
            >
              Skip — stay anonymous
            </button>
          </div>
        </form>
      )}

      {session !== null && <SessionView session={session} offline={!online} />}

      {offline !== null && <OfflineView result={offline} offline={!online} />}

      {history.length > 0 && (
        <section className="panel">
          <h2 className="panel-title">Recent look-ups</h2>
          <p className="panel-hint">
            Held in this browser tab only — never sent to or stored on the server.
          </p>
          <ul className="history">
            {history.map((entry) => (
              <li key={entry.code}>
                <button className="link-button" onClick={() => void lookup(entry.code)}>
                  {formatCode(entry.code)}
                </button>
                <span className="history-time">
                  {new Date(entry.at).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* The key input only exists when this build has NO baked-in demo key —
          i.e. someone self-hosting against their own resolver. On the public
          demo the key is already provided, so the field is redundant, and a
          credential-shaped input on an emergency-framed page is exactly what a
          safe-browsing scanner misreads as phishing. So it is not rendered at
          all in the demo build rather than merely hidden. */}
      {DEMO_KEY === '' && (
        <details className="panel">
          <summary className="panel-title">Resolver connection (self-hosting)</summary>
          <label className="field-label" htmlFor="api-key">
            Resolver key
          </label>
          <input
            id="api-key"
            className="note-input"
            value={apiKey}
            onChange={(event) => saveKey(event.target.value)}
            placeholder="Leave blank if the resolver is in open mode"
            autoComplete="off"
          />
          <p className="panel-hint">
            Only needed when pointing this at your own resolver. Kept in this
            tab's session storage.
          </p>
        </details>
      )}
    </div>
  );
}

/**
 * An offline code resolved with no server involved.
 *
 * The dispatcher must be told this is a *different kind of answer*. A session
 * code was minted moments ago by a real device and carries provenance: when,
 * how accurate, whose position, any note. An offline code carries a location
 * and nothing else — it could have been computed last year and written on a
 * whiteboard. Presenting the two identically would invite a dispatcher to
 * assume a freshness that is not there.
 */
function OfflineView({ result, offline }: { result: OfflineResult; offline: boolean }) {
  const { position } = result;
  const { account } = useAccount();
  const formats = allFormats(position.lat, position.lon);
  const cellSize = Math.max(1, Math.round(position.cellSizeM));

  return (
    <>
      <div className="notice notice-offline">
        <strong>Offline code — resolved without a server.</strong>
        <span>
          This is a fixed grid reference, accurate to about {cellSize}m. It carries no
          timestamp, no accuracy reading and no sender — it says where, and nothing else.
        </span>
      </div>

      <Map
        lat={position.lat}
        lon={position.lon}
        accuracyM={position.cellSizeM}
        offline={offline}
        tiles="dark"
        allowFullscreen
        showViewerLocation
        viewerAvatar={account.avatar}
      />

      <SaveMapButton
        data={() => ({
          lat: position.lat,
          lon: position.lon,
          accuracyM: position.cellSizeM,
          note: '',
          sketch: null,
          marker: null,
          thirdParty: false,
          source: 'lookup',
          code: result.code,
        })}
      />

      <section className="panel">
        <h2 className="panel-title">Location</h2>
        <CopyRow label="Latitude, longitude" value={formats.latLon} />
        {formats.plusCode !== null && <CopyRow label="Plus Code" value={formats.plusCode} />}
        {formats.osGridRef !== null && (
          <CopyRow label="OS grid reference" value={formats.osGridRef} />
        )}
        <CopyRow
          label="Full details"
          value={`${formats.latLon} (offline code ${formatOfflineCode(result.code)}, ±${cellSize}m)`}
        />
        <CopyRow label="Google Maps" value="Open in Google Maps" href={formats.googleMapsUrl} />
        <OpenInMaps lat={position.lat} lon={position.lon} label={formatOfflineCode(result.code)} />
      </section>
    </>
  );
}

function SessionView({ session, offline }: { session: ResolvedWithWarning; offline: boolean }) {
  const { position } = session;
  const { account } = useAccount();
  const formats = allFormats(position.lat, position.lon);
  const thirdParty = session.subject === 'third-party';
  const remaining = timeRemaining(session.expiresAt);

  // Decoded defensively: null means a malformed payload, and the right
  // response is to render the position without the drawing, not to blank the
  // screen. A dispatcher losing the position because a sketch failed to parse
  // would be a bad trade.
  const sketch = useMemo(
    () => (session.sketch !== undefined ? decodeSketch(session.sketch) : null),
    [session.sketch],
  );

  // Everything the caller marked. An old server sends only the legacy single
  // marker; the mirror rule makes it markers[0] here.
  const markers = useMemo<SessionMarker[]>(() => {
    if (session.markers !== undefined) return session.markers;
    if (session.marker !== undefined) {
      return [{ id: 'legacy', position: session.marker, icon: session.markerIcon ?? 'spot' }];
    }
    return [];
  }, [session.markers, session.marker, session.markerIcon]);

  const cadLine = `${formats.latLon} (±${Math.round(position.accuracyM)}m, ${position.source})${
    formats.osGridRef !== null ? ` [${formats.osGridRef}]` : ''
  }`;

  // The name the caller gave the spot they reported — the read-back handle
  // ("blue tent by the weir"), never an address.
  const markerName = (markers[0]?.name ?? '').trim();

  return (
    <>
      {session.warning !== undefined && (
        <div className="notice notice-warn">{session.warning}</div>
      )}

      <Map
        lat={position.lat}
        lon={position.lon}
        accuracyM={position.accuracyM}
        thirdParty={thirdParty}
        offline={offline}
        tiles="dark"
        sketch={sketch}
        fitContent
        allowFullscreen
        showViewerLocation
        viewerAvatar={account.avatar}
        {...(markers.length > 0
          ? {
              placedMarkers: markers.map((marker) => {
                const title = (marker.name ?? '').trim();
                const url = openInMapsUrl(
                  marker.position.lat,
                  marker.position.lon,
                  title !== '' ? title : 'Marked spot',
                );
                return {
                  id: marker.id,
                  label: 'Spot',
                  name: marker.name,
                  position: marker.position,
                  icon: marker.icon,
                  popupHtml: `${title !== '' ? `<strong>${escapeHtml(title)}</strong><br/>` : ''}<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open in maps</a>`,
                };
              }),
            }
          : {})}
      />

      <SaveMapButton
        suggestedName={session.note?.trim() ?? ''}
        data={() => ({
          lat: position.lat,
          lon: position.lon,
          accuracyM: position.accuracyM,
          note: session.note?.trim() ?? '',
          sketch: session.sketch ?? null,
          marker: session.marker ?? null,
          ...(session.markerIcon !== undefined ? { markerIcon: session.markerIcon } : {}),
          thirdParty,
          source: 'lookup',
          code: session.code,
        })}
      />

      {/* The diamonds are claims about the world, never a live fix — one
          quiet line keeps the two apart without shouting about it. The
          marker-share case gets its own line under the badge below. */}
      {!thirdParty && markers.length > 0 && (
        <p className="sketch-provenance">
          <strong>
            They marked{' '}
            {markers.length === 1
              ? markerName !== ''
                ? <>“{markerName}”</>
                : 'a spot'
              : `${markers.length} spots`}
            .
          </strong>{' '}
          {markers.length === 1 ? 'The diamond is' : 'The diamonds are'} somewhere they pointed
          out — not where they are.
        </p>
      )}

      {sketch !== null && (
        <p className="sketch-provenance">
          <strong>They drew this.</strong> It is their sketch of the scene, not survey
          data, and the colours carry no meaning.
        </p>
      )}

      <section className="panel">
        <div className="fix-summary">
          <span className={`fix-badge ${thirdParty ? 'fix-badge-third' : ''}`}>
            {thirdParty ? 'Marked spot' : session.mode === 'live' ? 'Live position' : 'Their position'}
          </span>
          <span>{describeSource(position.source, position.accuracyM)}</span>
          {/* A live session's position only moves while the sharer is
              actually sharing, and they may have switched that off. The
              record has no field saying so, so this says the one thing it
              CAN prove: when the position last moved. Read it, do not
              assume it. */}
          {session.mode === 'live' && <span>Updated {clockTime(session.updatedAt)}</span>}
          <span className="fix-expiry">Expires in {remaining}</span>
        </div>

        {/* A marker-share's position IS the spot they pointed out. Said
            once, plainly, where the position is read — not as a warning. */}
        {thirdParty && (
          <p className="fix-caveat">
            Marked spot — not their live position.
            {markerName !== '' && <> They call it “{markerName}”.</>}
          </p>
        )}

        {session.note !== undefined && session.note !== '' && (
          <p className="caller-note">“{session.note}”</p>
        )}

        {session.mode === 'live' && (
          <p className="live-indicator">
            {/* Deliberately NOT "they are sharing live". Sharing is a switch
                the caller can turn off at any moment, leaving the code
                pointing at the last position it was given; this line
                promises only what the session mode actually guarantees. */}
            <span className="live-dot" /> Live session — this position updates while they are
            sharing
          </p>
        )}
      </section>

      <section className="panel">
        <h2 className="panel-title">Location</h2>
        <CopyRow label="Latitude, longitude" value={formats.latLon} />
        {formats.plusCode !== null && <CopyRow label="Plus Code" value={formats.plusCode} />}
        {formats.osGridRef !== null && (
          <CopyRow label="OS grid reference" value={formats.osGridRef} />
        )}
        <CopyRow label="Full details" value={cadLine} />
        <CopyRow label="Google Maps" value="Open in Google Maps" href={formats.googleMapsUrl} />
        <OpenInMaps lat={position.lat} lon={position.lon} label={formatCode(session.code)} />
      </section>
    </>
  );
}
