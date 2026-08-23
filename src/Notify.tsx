import { useEffect, useRef, useState } from 'react';
import {
  enablePushForSession,
  pushAvailable,
  rememberSubscription,
  rememberedSubscription,
} from './push.js';

/**
 * The "notify me" affordance, in two dress codes: a quiet text row on the
 * issued-document code screen, and an icon button on the live bar. One state
 * machine behind both.
 *
 * It never asks for permission until tapped, and it never renders at all on
 * a platform that cannot deliver (iOS Safari not installed to the home
 * screen, a deployment with no VAPID keys) — a control that would dead-end
 * is worse than no control.
 */

type NotifyState = 'checking' | 'unavailable' | 'idle' | 'busy' | 'on' | 'denied' | 'failed';

export function NotifyControl({ code, variant }: { code: string; variant: 'document' | 'live' }) {
  const [state, setState] = useState<NotifyState>('checking');
  const keyRef = useRef('');

  useEffect(() => {
    let cancelled = false;
    if (rememberedSubscription(code)) {
      setState('on');
      return;
    }
    // Availability first (support + server keys), so an unusable affordance
    // never shows. This GET carries nothing and prompts for nothing.
    void pushAvailable().then(({ available, vapidPublicKey }) => {
      if (cancelled) return;
      keyRef.current = vapidPublicKey;
      setState(available ? 'idle' : 'unavailable');
    });
    return () => {
      cancelled = true;
    };
  }, [code]);

  // Called from the tap itself: the permission prompt inside is the first
  // await, so the browser still counts the gesture.
  const enable = () => {
    setState('busy');
    void enablePushForSession(code, keyRef.current).then((outcome) => {
      if (outcome === 'subscribed') {
        rememberSubscription(code);
        setState('on');
      } else if (outcome === 'denied') {
        setState('denied');
      } else if (outcome === 'unavailable') {
        setState('unavailable');
      } else {
        setState('failed');
      }
    });
  };

  if (state === 'checking' || state === 'unavailable') return null;

  if (variant === 'document') {
    return (
      <div className="notify-row">
        {state === 'idle' && (
          <button type="button" className="link-button" onClick={enable}>
            Notify me when something happens
          </button>
        )}
        {state === 'busy' && <p className="notify-note">Setting up notifications…</p>}
        {state === 'on' && (
          <p className="notify-note">
            Notifications are on — this phone will hear when someone looks up the code, someone
            joins, or it is close to expiring.
          </p>
        )}
        {state === 'denied' && (
          <p className="notify-note">
            Notifications are blocked for this site. Allow them in your browser settings, then try
            again.
          </p>
        )}
        {state === 'failed' && (
          <p className="notify-note">
            Could not set up notifications.{' '}
            <button type="button" className="link-button" onClick={enable}>
              Try again
            </button>
          </p>
        )}
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        className={`button live-chat-button ${state === 'on' ? 'notify-on' : ''}`}
        aria-label={state === 'on' ? 'Notifications are on' : 'Notify me about this session'}
        title={state === 'on' ? 'Notifications are on' : 'Notify me about this session'}
        aria-pressed={state === 'on'}
        disabled={state === 'busy' || state === 'on'}
        onClick={state === 'busy' || state === 'on' ? undefined : enable}
      >
        <BellIcon />
      </button>
      {state === 'denied' && (
        <p className="live-bar-note">
          Notifications are blocked for this site — allow them in your browser settings.
        </p>
      )}
      {state === 'failed' && (
        <p className="live-bar-note">Could not set up notifications. Tap the bell to try again.</p>
      )}
    </>
  );
}

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 3.2c-3 0-5 2.2-5 5.2v3.4l-1.6 3.4h13.2L17 11.8V8.4c0-3-2-5.2-5-5.2Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M10 17.9a2 2 0 0 0 4 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}
