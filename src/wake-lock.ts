import { useEffect } from 'react';

/**
 * Keep the screen awake while a live share is actually running.
 *
 * Browsers stop delivering geolocation fixes the moment the screen sleeps, so
 * a sharer who pockets their phone quietly stops moving on everyone else's
 * map. The screen wake lock is the mitigation the platform actually offers a
 * web app; the trade (screen-on battery cost) is only paid while a live share
 * is open, never on the static screens.
 *
 * Deliberately quiet: feature-detected, every failure swallowed. A wake lock
 * the platform refuses (battery saver, unsupported browser) degrades to
 * exactly today's behaviour, and telling a frightened person about it would
 * help nobody. Nothing here is ever logged.
 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return;

    let sentinel: WakeLockSentinel | null = null;
    let stopped = false;

    const acquire = (): void => {
      if (stopped || document.visibilityState !== 'visible') return;
      navigator.wakeLock
        .request('screen')
        .then((lock) => {
          if (stopped) {
            void lock.release().catch(() => undefined);
            return;
          }
          sentinel = lock;
        })
        .catch(() => {
          // Refused (battery saver, permissions policy) — silently accepted.
        });
    };

    // The platform releases the lock whenever the page hides; coming back
    // must re-acquire or the very next pocket-moment kills the share again.
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible' && (sentinel === null || sentinel.released)) {
        acquire();
      }
    };

    acquire();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisibility);
      void sentinel?.release().catch(() => undefined);
      sentinel = null;
    };
  }, [active]);
}

/**
 * One immediate geolocation fix, pushed to `send`, for the moment a live
 * share comes back to the foreground: the regular watchPosition can take
 * seconds to wake up, and the gap between "screen on" and "dot moves" is
 * exactly when someone is checking whether the share still works.
 */
export function useResumeFix(active: boolean, send: (fix: GeolocationPosition) => void): void {
  useEffect(() => {
    if (!active || !('geolocation' in navigator)) return;
    const onVisibility = (): void => {
      if (document.visibilityState !== 'visible') return;
      navigator.geolocation.getCurrentPosition(send, () => undefined, {
        enableHighAccuracy: true,
        maximumAge: 5_000,
        timeout: 15_000,
      });
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [active, send]);
}
