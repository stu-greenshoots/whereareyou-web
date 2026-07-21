import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  formatCode,
  formatOfflineCode,
  interpretCode,
  type OfflinePosition,
} from '@whereareyou/protocol';
import { resolveSession, type ResolvedWithWarning } from './api.js';
import { Map } from './Map.jsx';
import { CopyRow } from './CopyRow.jsx';
import { allFormats, describeSource, timeRemaining } from './formats.js';

/** Human-readable explanation of why input was rejected before submission. */
const PARSE_HINTS: Record<string, string> = {
  empty: '',
  unreadable: "That doesn't look like a code.",
  'too-short': 'Keep going — 8 characters for a live code, 10 for an offline one.',
  'too-long': 'That is too long. Live codes are 8 characters, offline codes 10.',
  'bad-checksum': 'That code has a typo — check it with the caller.',
};

interface HistoryEntry {
  code: string;
  at: number;
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

export function Resolve() {
  const [input, setInput] = useState('');
  const [apiKey, setApiKey] = useState(() => sessionStorage.getItem('resolverKey') ?? DEMO_KEY);
  const [session, setSession] = useState<ResolvedWithWarning | null>(null);
  const [offline, setOffline] = useState<OfflineResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [, forceTick] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

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

      setBusy(true);
      setError(null);
      setOffline(null);
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

        <button className="button" type="submit" disabled={busy || !ready}>
          {busy ? 'Looking up…' : 'Look up'}
        </button>
      </form>

      {error !== null && <div className="notice notice-warn">{error}</div>}

      {session !== null && <SessionView session={session} />}

      {offline !== null && <OfflineView result={offline} />}

      {history.length > 0 && (
        <section className="panel">
          <h2 className="panel-title">This shift</h2>
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
function OfflineView({ result }: { result: OfflineResult }) {
  const { position } = result;
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

      <Map lat={position.lat} lon={position.lon} accuracyM={position.cellSizeM} />

      <section className="panel">
        <h2 className="panel-title">Location</h2>
        <CopyRow label="Latitude, longitude" value={formats.latLon} />
        {formats.plusCode !== null && <CopyRow label="Plus Code" value={formats.plusCode} />}
        {formats.osGridRef !== null && (
          <CopyRow label="OS grid reference" value={formats.osGridRef} />
        )}
        <CopyRow
          label="Copy for CAD"
          value={`${formats.latLon} (offline code ${formatOfflineCode(result.code)}, ±${cellSize}m)`}
        />
        <CopyRow label="Google Maps" value="Open in Google Maps" href={formats.googleMapsUrl} />
      </section>
    </>
  );
}

function SessionView({ session }: { session: ResolvedWithWarning }) {
  const { position } = session;
  const formats = allFormats(position.lat, position.lon);
  const thirdParty = session.subject === 'third-party';
  const remaining = timeRemaining(session.expiresAt);

  const cadLine = `${formats.latLon} (±${Math.round(position.accuracyM)}m, ${position.source})${
    formats.osGridRef !== null ? ` [${formats.osGridRef}]` : ''
  }`;

  return (
    <>
      {thirdParty && (
        <div className="notice notice-thirdparty">
          <strong>Reported location — not the caller's own position.</strong>
          <span>The caller told us about somewhere else. They are not necessarily here.</span>
        </div>
      )}

      {session.warning !== undefined && (
        <div className="notice notice-warn">{session.warning}</div>
      )}

      <Map
        lat={position.lat}
        lon={position.lon}
        accuracyM={position.accuracyM}
        thirdParty={thirdParty}
      />

      <section className="panel">
        <div className="fix-summary">
          <span className={`fix-badge ${thirdParty ? 'fix-badge-third' : ''}`}>
            {thirdParty ? 'Reported' : "Caller's position"}
          </span>
          <span>{describeSource(position.source, position.accuracyM)}</span>
          <span className="fix-expiry">Expires in {remaining}</span>
        </div>

        {session.note !== undefined && session.note !== '' && (
          <p className="caller-note">“{session.note}”</p>
        )}

        {session.mode === 'live' && (
          <p className="live-indicator">
            <span className="live-dot" /> Live session — position may change
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
        <CopyRow label="Copy for CAD" value={cadLine} />
        <CopyRow label="Google Maps" value="Open in Google Maps" href={formats.googleMapsUrl} />
      </section>
    </>
  );
}
