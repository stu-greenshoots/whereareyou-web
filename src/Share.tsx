import { useCallback, useEffect, useRef, useState } from 'react';
import { encodeOffline, formatCode, formatOfflineCode, phoneticFor } from '@whereareyou/protocol';
import type { CreateSessionResponse, Position, SessionMode } from '@whereareyou/protocol';
import { mintSession, revokeSession, updatePosition } from './api.js';
import { useConnectivity } from './connectivity.js';
import { Map } from './Map.jsx';
import { CopyRow } from './CopyRow.jsx';
import { allFormats, inferSource, timeRemaining } from './formats.js';

/** Why we ended up handing out a permanent code instead of a session. */
type OfflineCause =
  /** The browser says the link is down. */
  | 'no-link'
  /** We tried and nothing on the network answered. */
  | 'no-network'
  /** Something answered, and refused. */
  | 'service';

type Phase =
  | { name: 'idle' }
  | { name: 'locating' }
  | { name: 'located'; position: Position }
  /**
   * `spokenOfflineCode` is carried through minting and into the shared phase:
   * once a caller has read a code down the phone it exists in the world, and
   * every later screen has to keep telling the truth about it.
   */
  | { name: 'minting'; position: Position; spokenOfflineCode: string | null }
  | {
      name: 'shared';
      position: Position;
      session: CreateSessionResponse;
      spokenOfflineCode: string | null;
    }
  | {
      name: 'offline-shared';
      position: Position;
      code: string;
      cause: OfflineCause;
      detail: string | null;
    }
  | { name: 'error'; message: string; recoverable: boolean };

/** Somewhere recognisable to fall back to when there is no usable fix. */
const DEMO_POSITION: Position = {
  lat: 51.50809,
  lon: -0.12789,
  accuracyM: 12,
  source: 'manual',
  takenAt: new Date().toISOString(),
};

function geolocationErrorMessage(error: GeolocationPositionError): {
  message: string;
  recoverable: boolean;
} {
  switch (error.code) {
    case error.PERMISSION_DENIED:
      return {
        message:
          'Location permission was refused. You can still place a pin on the map manually.',
        recoverable: true,
      };
    case error.POSITION_UNAVAILABLE:
      return {
        message: 'No position fix available. Move somewhere with a clearer view of the sky, or place a pin manually.',
        recoverable: true,
      };
    case error.TIMEOUT:
      return { message: 'Timed out waiting for a fix. Try again, or place a pin manually.', recoverable: true };
    default:
      return { message: 'Could not get a location.', recoverable: true };
  }
}

export function Share() {
  const [phase, setPhase] = useState<Phase>({ name: 'idle' });
  const [thirdParty, setThirdParty] = useState(false);
  const [mode, setMode] = useState<SessionMode>('static');
  const [note, setNote] = useState('');
  const [, forceTick] = useState(0);
  const watchRef = useRef<number | null>(null);
  const { online, linkUp, reportReachable, reportUnreachable } = useConnectivity();

  /** Set when the caller has declined the offer of an expiring code. */
  const [keepingOfflineCode, setKeepingOfflineCode] = useState(false);
  /** Set when "stop sharing" could not reach the server. */
  const [stopFailure, setStopFailure] = useState<string | null>(null);

  // Drive the expiry countdown.
  useEffect(() => {
    if (phase.name !== 'shared') return;
    const timer = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [phase.name]);

  const locate = useCallback(() => {
    if (!('geolocation' in navigator)) {
      setPhase({
        name: 'error',
        message: 'This browser cannot provide a location. Place a pin manually instead.',
        recoverable: true,
      });
      return;
    }

    setPhase({ name: 'locating' });
    navigator.geolocation.getCurrentPosition(
      (fix) => {
        setPhase({
          name: 'located',
          position: {
            lat: fix.coords.latitude,
            lon: fix.coords.longitude,
            accuracyM: fix.coords.accuracy,
            // The browser never reports which sensor produced the fix, so this
            // is inferred from the accuracy radius. See GNSS_ACCURACY_THRESHOLD_M.
            source: inferSource(fix.coords.accuracy),
            takenAt: new Date(fix.timestamp).toISOString(),
          },
        });
      },
      (error) => setPhase({ name: 'error', ...geolocationErrorMessage(error) }),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    );
  }, []);

  const useManualPin = useCallback(() => {
    setThirdParty(true);
    setPhase({ name: 'located', position: { ...DEMO_POSITION, takenAt: new Date().toISOString() } });
  }, []);

  /**
   * Hand the caller a permanent, self-contained code.
   *
   * No network is involved: the position is inside the code. This is the whole
   * point of the offline codec, and it is why losing signal degrades the
   * product rather than breaking it.
   */
  const fallToOfflineCode = useCallback(
    (position: Position, cause: OfflineCause, detail: string | null, existingCode?: string) => {
      setKeepingOfflineCode(false);
      setPhase({
        name: 'offline-shared',
        position,
        code: existingCode ?? encodeOffline(position.lat, position.lon),
        cause,
        detail,
      });
    },
    [],
  );

  const mint = useCallback(
    async (position: Position, spokenOfflineCode: string | null) => {
      setPhase({ name: 'minting', position, spokenOfflineCode });

      const result = await mintSession({
        position,
        mode,
        subject: thirdParty ? 'third-party' : 'self',
        ...(note.trim() !== '' ? { note: note.trim() } : {}),
      });

      if (!result.ok) {
        // A thrown fetch or a 5xx means the route is the problem; a 4xx means
        // we got through and were refused, which says nothing about the link.
        if (result.status === 0 || result.status >= 500) reportUnreachable();
        else reportReachable();

        // Never a dead end. We cannot mint a session, but we can always give
        // the caller something they can read down a phone right now.
        fallToOfflineCode(
          position,
          result.status === 0 ? 'no-network' : 'service',
          result.message,
          spokenOfflineCode ?? undefined,
        );
        return;
      }

      reportReachable();
      setPhase({ name: 'shared', position, session: result.data, spokenOfflineCode });
    },
    [mode, thirdParty, note, fallToOfflineCode, reportReachable, reportUnreachable],
  );

  const share = useCallback(() => {
    if (phase.name !== 'located') return;

    // When the browser says the link is down it is telling the truth, and a
    // request that cannot succeed is not worth a frightened person's seconds.
    if (!linkUp) {
      fallToOfflineCode(phase.position, 'no-link', null);
      return;
    }
    void mint(phase.position, null);
  }, [phase, linkUp, mint, fallToOfflineCode]);

  // Live mode: stream position updates until expiry or revocation.
  useEffect(() => {
    if (phase.name !== 'shared' || phase.session === undefined || mode !== 'live') return;
    if (!('geolocation' in navigator)) return;

    const { code, updateToken } = phase.session;
    watchRef.current = navigator.geolocation.watchPosition(
      (fix) => {
        void updatePosition(code, updateToken, {
          lat: fix.coords.latitude,
          lon: fix.coords.longitude,
          accuracyM: fix.coords.accuracy,
          source: inferSource(fix.coords.accuracy),
          takenAt: new Date(fix.timestamp).toISOString(),
        });
      },
      undefined,
      // Throttle by distance rather than time so a stationary phone stops
      // transmitting instead of burning battery repeating itself.
      { enableHighAccuracy: true, maximumAge: 10_000 },
    );

    return () => {
      if (watchRef.current !== null) navigator.geolocation.clearWatch(watchRef.current);
      watchRef.current = null;
    };
  }, [phase, mode]);

  const startAgain = useCallback(() => {
    setStopFailure(null);
    setKeepingOfflineCode(false);
    setPhase({ name: 'idle' });
  }, []);

  const revoke = useCallback(async () => {
    if (phase.name !== 'shared') return;

    const result = await revokeSession(phase.session.code, phase.session.updateToken);
    if (!result.ok) {
      if (result.status === 0) reportUnreachable();
      // Silently returning to the start screen here would tell the caller their
      // location had stopped being shared when it had not. Being wrong about
      // that is the worst thing this screen can do.
      setStopFailure(result.message);
      return;
    }
    startAgain();
  }, [phase, reportUnreachable, startAgain]);

  const nativeShare = useCallback(async () => {
    let text: string;
    if (phase.name === 'shared') {
      const { display, phonetic } = phase.session;
      text = `My location code is ${display} — spoken: ${phonetic}. Look it up at ${location.origin}/lookup`;
    } else if (phase.name === 'offline-shared') {
      // Spelled out as an offline code, because it behaves differently from a
      // session code at the other end and the recipient needs to know that.
      text = `My offline location code is ${formatOfflineCode(phase.code)} — spoken: ${[...phase.code]
        .map((char) => phoneticFor(char))
        .join(' ')}. It does not expire. Look it up at ${location.origin}/lookup`;
    } else {
      return;
    }

    if ('share' in navigator) {
      try {
        await navigator.share({ title: 'My location code', text });
        return;
      } catch {
        // User dismissed the sheet, or the platform refused. Fall through.
      }
    }
    await navigator.clipboard.writeText(text);
  }, [phase]);

  // ---- Render -----------------------------------------------------------

  if (phase.name === 'idle' || phase.name === 'locating' || phase.name === 'error') {
    return (
      <div className="stack centred">
        {!online && <NoSignalNotice linkUp={linkUp} />}

        <button className="big-button" onClick={locate} disabled={phase.name === 'locating'}>
          {phase.name === 'locating' ? 'Getting your location…' : 'Share my location'}
        </button>

        {phase.name === 'error' && (
          <div className="notice notice-warn">
            <p>{phase.message}</p>
            {phase.recoverable && (
              <button className="link-button" onClick={useManualPin}>
                Place a pin on the map instead
              </button>
            )}
          </div>
        )}

        {phase.name === 'idle' && (
          <button className="link-button" onClick={useManualPin}>
            Report a different location instead
          </button>
        )}
      </div>
    );
  }

  const position = phase.position;
  const formats = allFormats(position.lat, position.lon);

  if (phase.name === 'located' || phase.name === 'minting') {
    return (
      <div className="stack">
        {!online && <NoSignalNotice linkUp={linkUp} />}

        <Map
          lat={position.lat}
          lon={position.lon}
          accuracyM={position.accuracyM}
          thirdParty={thirdParty}
          offline={!online}
          onMove={(lat, lon) =>
            setPhase({
              name: 'located',
              position: { ...position, lat, lon, source: 'manual', takenAt: new Date().toISOString() },
            })
          }
        />

        <label className="toggle">
          <input
            type="checkbox"
            checked={thirdParty}
            onChange={(event) => setThirdParty(event.target.checked)}
          />
          <span>
            <strong>This is not where I am</strong>
            <small>I'm reporting somewhere else — drag the pin to it</small>
          </span>
        </label>

        <label className="toggle">
          <input
            type="checkbox"
            checked={mode === 'live' && online}
            disabled={!online}
            onChange={(event) => setMode(event.target.checked ? 'live' : 'static')}
          />
          <span>
            <strong>Keep updating my position</strong>
            <small>
              {online
                ? "For when you're moving. Uses more battery."
                : 'Needs a connection — a code that follows you has to live on the server.'}
            </small>
          </span>
        </label>

        <input
          className="note-input"
          placeholder="Anything else? e.g. third floor, back stairwell"
          value={note}
          maxLength={280}
          onChange={(event) => setNote(event.target.value)}
        />

        <CoordinatePanel formats={formats} position={position} />

        <button className="big-button" onClick={share} disabled={phase.name === 'minting'}>
          {phase.name === 'minting'
            ? 'Creating code…'
            : online
              ? 'Get my code'
              : 'Get my offline code'}
        </button>
      </div>
    );
  }

  if (phase.name === 'offline-shared') {
    return (
      <OfflineShared
        phase={phase}
        formats={formats}
        thirdParty={thirdParty}
        liveWanted={mode === 'live'}
        online={online}
        keeping={keepingOfflineCode}
        onKeep={() => setKeepingOfflineCode(true)}
        onUpgrade={() => void mint(phase.position, phase.code)}
        onShare={() => void nativeShare()}
        onStartAgain={startAgain}
      />
    );
  }

  // phase.name === 'shared'
  const { session } = phase;
  const remaining = timeRemaining(session.expiresAt);
  const expired = remaining === 'expired';

  return (
    <div className="stack">
      <div className={`code-doc ${expired ? 'code-expired' : ''}`}>
        <div className="code-doc-head">
          <span className="label">Location code</span>
          <span className="code-expiry">{expired ? 'Expired' : remaining}</span>
        </div>

        <div className="code-doc-body">
          <p className="code">{formatCode(session.code)}</p>

          <div className="read-aloud">
            <span className="label">Read aloud to the operator</span>
            <PhoneticGrid code={session.code} />
          </div>
        </div>
      </div>

      {/* The caller already read this one aloud. It is out in the world and
          permanent, and quietly replacing it with the code above would leave
          them believing something untrue about their own privacy. */}
      {phase.spokenOfflineCode !== null && (
        <div className="notice notice-offline">
          <strong>You already read out {formatOfflineCode(phase.spokenOfflineCode)}.</strong>
          <span>
            That one still works, and it still never expires — stopping the code above does not
            take it back. Tell the operator to use the new code if you can.
          </span>
        </div>
      )}

      <div className="row">
        <button className="button button-primary" onClick={nativeShare}>
          Share code
        </button>
        <button
          className="button button-danger"
          onClick={expired ? startAgain : () => void revoke()}
        >
          {expired ? 'Start again' : 'Stop sharing'}
        </button>
      </div>

      {stopFailure !== null && (
        <div className="notice notice-warn">
          <strong>Could not stop the sharing.</strong>
          <span>
            {stopFailure} The code above is still live and will stop on its own in {remaining}.
          </span>
          <div className="notice-actions">
            <button className="button" onClick={() => void revoke()}>
              Try again
            </button>
            <button className="link-button" onClick={startAgain}>
              Leave it running and start over
            </button>
          </div>
        </div>
      )}

      {/* The session lives on the server, so the code keeps resolving even
          though this phone has gone quiet. Saying so is the difference between
          a calm screen and a caller reading out a code they think is dead. */}
      {!online && !expired && (
        <div className="notice notice-warn">
          <strong>You've lost your connection.</strong>
          <span>
            The code above still works — it was handed to the server before the signal went.
            {mode === 'live' && ' Your position has stopped updating, though.'} If the operator
            cannot find it, read out the offline code below instead: that one needs no network at
            either end.
          </span>
        </div>
      )}

      {mode === 'live' && !expired && online && (
        <div className="notice notice-live">
          <span className="live-dot" /> Your position is being shared live
        </div>
      )}

      <Map
        lat={position.lat}
        lon={position.lon}
        accuracyM={position.accuracyM}
        thirdParty={thirdParty}
        offline={!online}
      />

      <CoordinatePanel formats={formats} position={position} />
    </div>
  );
}

/**
 * The offline code presented as the issued document.
 *
 * Everything a session code gets — the frame, the size, the phonetic grid — an
 * offline code gets too, because with no signal it is not a fallback, it is the
 * product. What it does not get is anything that resembles a countdown: this
 * code cannot be stopped, and styling it like one that can would be a lie about
 * the caller's own privacy.
 */
function OfflineShared({
  phase,
  formats,
  thirdParty,
  liveWanted,
  online,
  keeping,
  onKeep,
  onUpgrade,
  onShare,
  onStartAgain,
}: {
  phase: Extract<Phase, { name: 'offline-shared' }>;
  formats: ReturnType<typeof allFormats>;
  thirdParty: boolean;
  liveWanted: boolean;
  online: boolean;
  keeping: boolean;
  onKeep: () => void;
  onUpgrade: () => void;
  onShare: () => void;
  onStartAgain: () => void;
}) {
  const { position, code, cause, detail } = phase;

  return (
    <div className="stack">
      <div className="code-doc code-doc-offline">
        <div className="code-doc-head">
          <span className="label">Offline code</span>
          <span className="code-permanent">Does not expire</span>
        </div>

        <div className="code-doc-body">
          <p className="code code-offline">{formatOfflineCode(code)}</p>

          <div className="read-aloud">
            <span className="label">Read aloud to the operator</span>
            <PhoneticGrid code={code} />
          </div>
        </div>
      </div>

      <div className="notice notice-offline">
        <strong>This code never expires and cannot be stopped.</strong>
        <span>
          Your position is built into the code itself, which is what lets it work with no signal —
          at either end. It also means there is nothing to switch off: anyone who has these ten
          characters can find this spot, indefinitely. Only give it to the operator.
        </span>
      </div>

      <div className="row">
        <button className="button button-primary" onClick={onShare}>
          Share code
        </button>
        <button className="button" onClick={onStartAgain}>
          Start again
        </button>
      </div>

      <p className="offline-reason">
        {cause === 'no-link' && 'Your phone has no connection, so there was no way to create a code that expires.'}
        {cause === 'no-network' && 'Nothing on the network answered, so there was no way to create a code that expires.'}
        {cause === 'service' &&
          (detail !== null
            ? `The code service could be reached but would not issue a code — ${detail}`
            : 'The code service could be reached but would not issue a code.')}
        {liveWanted && ' A code that follows you as you move needs a connection; this one is a single fixed point.'}
      </p>

      {/* Never swap the code underneath them. They may already have read it
          down the phone, so an expiring code is offered, never imposed. */}
      {online && !keeping && (
        <div className="notice notice-offer">
          <strong>
            {cause === 'service'
              ? 'You can try again for a code that expires.'
              : "You're back online."}
          </strong>
          <span>
            A session code expires after half an hour and you can stop it at any time. The offline
            code above keeps working either way — if you have already read it out, the operator can
            still use it.
          </span>
          <div className="notice-actions">
            <button className="button button-primary" onClick={onUpgrade}>
              Get an expiring code
            </button>
            <button className="link-button" onClick={onKeep}>
              Keep this one
            </button>
          </div>
        </div>
      )}

      {online && keeping && (
        <button className="link-button" onClick={onUpgrade}>
          Get an expiring code instead
        </button>
      )}

      {!online && (
        <button className="link-button" onClick={onUpgrade}>
          Try again for a code that expires
        </button>
      )}

      <Map
        lat={position.lat}
        lon={position.lon}
        accuracyM={position.accuracyM}
        thirdParty={thirdParty}
        offline={!online}
      />

      <CoordinatePanel formats={formats} position={position} omitOfflineCode />
    </div>
  );
}

/**
 * Shown before a code exists, so the caller learns what they are about to get
 * *before* they press the button rather than being surprised by a permanent
 * code afterwards.
 */
function NoSignalNotice({ linkUp }: { linkUp: boolean }) {
  return (
    <div className="notice notice-offline">
      <strong>{linkUp ? 'Cannot reach the network.' : 'No connection.'}</strong>
      <span>
        You can still share where you are. You will get an offline code, which works with no signal
        because your position is inside the code — but it never expires and cannot be taken back.
      </span>
    </div>
  );
}

/**
 * Each phonetic word sits directly under the character it stands for.
 *
 * The spoken form is the real interface — it is what actually travels down the
 * phone line — so it gets presented as something to perform rather than as a
 * caption. Pairing word to character also means that when the operator asks
 * "sorry, was that the fifth one?", the caller can answer without re-reading
 * the whole string.
 */
function PhoneticGrid({ code }: { code: string }) {
  return (
    <div className="phonetic-grid">
      {[...code].map((char, index) => (
        <span className="phonetic-pair" key={`${char}-${index}`}>
          <span className="phonetic-char">{char}</span>
          <span className="phonetic-word">{phoneticFor(char)}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * The fallback panel. Always visible, always rendered from local state with no
 * network call — minting a code needs connectivity, and if that connectivity
 * goes away the caller must still have something they can read down the phone.
 */
function CoordinatePanel({
  formats,
  position,
  omitOfflineCode = false,
}: {
  formats: ReturnType<typeof allFormats>;
  position: Position;
  /** Set when the offline code is already the hero and repeating it would
      invite the caller to read out the same thing twice. */
  omitOfflineCode?: boolean;
}) {
  const offlineCode = encodeOffline(position.lat, position.lon);

  return (
    <section className="panel">
      <h2 className="panel-title">If the code doesn't work</h2>
      <p className="panel-hint">Any of these also identify this spot.</p>

      {/* Computed on this device with no network call, so it survives losing
          signal after the page has loaded — the one thing a session code
          cannot do. Listed first for that reason. */}
      {!omitOfflineCode && (
        <CopyRow label="Offline code — say this one" value={formatOfflineCode(offlineCode)} />
      )}
      <CopyRow label="Latitude, longitude" value={formats.latLon} />
      {formats.plusCode !== null && <CopyRow label="Plus Code" value={formats.plusCode} />}
      {formats.osGridRef !== null && <CopyRow label="OS grid reference" value={formats.osGridRef} />}
    </section>
  );
}
