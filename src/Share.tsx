import { useCallback, useEffect, useRef, useState } from 'react';
import { encodeOffline, formatCode, formatOfflineCode, phoneticFor } from '@whereareyou/protocol';
import type { CreateSessionResponse, Position, SessionMode } from '@whereareyou/protocol';
import { mintSession, revokeSession, updatePosition } from './api.js';
import { Map } from './Map.jsx';
import { CopyRow } from './CopyRow.jsx';
import { allFormats, inferSource, timeRemaining } from './formats.js';

type Phase =
  | { name: 'idle' }
  | { name: 'locating' }
  | { name: 'located'; position: Position }
  | { name: 'minting'; position: Position }
  | { name: 'shared'; position: Position; session: CreateSessionResponse }
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

  const share = useCallback(async () => {
    if (phase.name !== 'located') return;
    setPhase({ name: 'minting', position: phase.position });

    const result = await mintSession({
      position: phase.position,
      mode,
      subject: thirdParty ? 'third-party' : 'self',
      ...(note.trim() !== '' ? { note: note.trim() } : {}),
    });

    if (!result.ok) {
      setPhase({ name: 'error', message: result.message, recoverable: true });
      return;
    }
    setPhase({ name: 'shared', position: phase.position, session: result.data });
  }, [phase, mode, thirdParty, note]);

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

  const revoke = useCallback(async () => {
    if (phase.name !== 'shared') return;
    await revokeSession(phase.session.code, phase.session.updateToken);
    setPhase({ name: 'idle' });
  }, [phase]);

  const nativeShare = useCallback(async () => {
    if (phase.name !== 'shared') return;
    const { display, phonetic } = phase.session;
    const text = `My location code is ${display} — spoken: ${phonetic}. Resolve it at ${location.origin}/resolve`;
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

  const position =
    phase.name === 'located' || phase.name === 'minting' || phase.name === 'shared'
      ? phase.position
      : DEMO_POSITION;
  const formats = allFormats(position.lat, position.lon);

  if (phase.name === 'located' || phase.name === 'minting') {
    return (
      <div className="stack">
        <Map
          lat={position.lat}
          lon={position.lon}
          accuracyM={position.accuracyM}
          thirdParty={thirdParty}
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
            checked={mode === 'live'}
            onChange={(event) => setMode(event.target.checked ? 'live' : 'static')}
          />
          <span>
            <strong>Keep updating my position</strong>
            <small>For when you're moving. Uses more battery.</small>
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
          {phase.name === 'minting' ? 'Creating code…' : 'Get my code'}
        </button>
      </div>
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

      <div className="row">
        <button className="button button-primary" onClick={nativeShare}>
          Share code
        </button>
        <button className="button button-danger" onClick={revoke}>
          {expired ? 'Start again' : 'Stop sharing'}
        </button>
      </div>

      {mode === 'live' && !expired && (
        <div className="notice notice-live">
          <span className="live-dot" /> Your position is being shared live
        </div>
      )}

      <Map
        lat={position.lat}
        lon={position.lon}
        accuracyM={position.accuracyM}
        thirdParty={thirdParty}
      />

      <CoordinatePanel formats={formats} position={position} />
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
}: {
  formats: ReturnType<typeof allFormats>;
  position: Position;
}) {
  const offlineCode = encodeOffline(position.lat, position.lon);

  return (
    <section className="panel">
      <h2 className="panel-title">If the code doesn't work</h2>
      <p className="panel-hint">Any of these also identify this spot.</p>

      {/* Computed on this device with no network call, so it survives losing
          signal after the page has loaded — the one thing a session code
          cannot do. Listed first for that reason. */}
      <CopyRow label="Offline code — say this one" value={formatOfflineCode(offlineCode)} />
      <CopyRow label="Latitude, longitude" value={formats.latLon} />
      {formats.plusCode !== null && <CopyRow label="Plus Code" value={formats.plusCode} />}
      {formats.osGridRef !== null && <CopyRow label="OS grid reference" value={formats.osGridRef} />}
    </section>
  );
}
