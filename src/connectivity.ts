import { useCallback, useEffect, useState } from 'react';
import { probeResolver } from './api.js';

/**
 * How often to re-check reachability while we believe we are offline.
 *
 * Short enough that the offer of an expiring code appears while the phone is
 * still in the caller's hand, long enough not to be a battery cost on a device
 * that may already be low.
 */
const PROBE_INTERVAL_MS = 15_000;

/** What we currently believe about reaching the resolver. */
type Verified = 'unknown' | 'reachable' | 'unreachable';

export interface Connectivity {
  /**
   * Best current belief that a session code could actually be minted.
   * Optimistic while unproven — we would rather try and fail fast than refuse
   * to try at all.
   */
  online: boolean;
  /**
   * What the browser claims about the link. Trusted in one direction only:
   * when it says "offline" the link really is down, so there is no point
   * spending a frightened person's seconds on a request that cannot succeed.
   * When it says "online" it means almost nothing.
   */
  linkUp: boolean;
  /** Record that a real request failed for network reasons. */
  reportUnreachable: () => void;
  /** Record that a real request succeeded. Stronger evidence than any probe. */
  reportReachable: () => void;
}

/**
 * Connectivity as evidence rather than as a flag.
 *
 * Two sources, deliberately weighted: `navigator.onLine` for the link, and the
 * outcome of requests we actually made. The second always wins, because it is
 * the only one that has been tested against the thing we need.
 */
export function useConnectivity(): Connectivity {
  const [linkUp, setLinkUp] = useState(() => navigator.onLine);
  const [verified, setVerified] = useState<Verified>('unknown');

  const reportUnreachable = useCallback(() => setVerified('unreachable'), []);
  const reportReachable = useCallback(() => setVerified('reachable'), []);

  useEffect(() => {
    const goneOffline = () => {
      setLinkUp(false);
      // The link is down. This is the one thing navigator.onLine is reliable
      // about, so it counts as proof rather than a hint.
      setVerified('unreachable');
    };
    const cameOnline = () => {
      setLinkUp(true);
      // A link is not a route. Drop back to "unproven" and let the probe below
      // decide — this is exactly the captive-portal case.
      setVerified('unknown');
    };

    window.addEventListener('offline', goneOffline);
    window.addEventListener('online', cameOnline);
    return () => {
      window.removeEventListener('offline', goneOffline);
      window.removeEventListener('online', cameOnline);
    };
  }, []);

  // A request that actually reached the resolver outranks anything the browser
  // says about the link. Otherwise fall back to the link, optimistically.
  const online = verified === 'reachable' || (linkUp && verified === 'unknown');

  // Keep probing the resolver until a request has genuinely reached it. This
  // covers two states the browser cannot tell apart, and `navigator.onLine` is
  // useless in both:
  //   - we believe we are offline, waiting to recover — the `online` event
  //     often never fires (walking out of a lift, finally signing into a
  //     captive portal), so waiting for one would strand the caller on a
  //     permanent code they did not need;
  //   - we are optimistically "online" but unproven (`verified === 'unknown'`)
  //     — the link is up but may carry no route out, the captive-portal case,
  //     which only a real request can detect.
  // A successful probe promotes us to proven-reachable; a failed one records
  // the unreachability, so a silent network death (no `offline` event) downgrades
  // us instead of leaving the app believing it is connected. A real mint still
  // outranks either (see the report* callbacks). We stop probing only once
  // genuinely proven reachable.
  useEffect(() => {
    if (verified === 'reachable') return;

    let cancelled = false;
    const check = async () => {
      const reachable = await probeResolver();
      if (!cancelled) setVerified(reachable ? 'reachable' : 'unreachable');
    };

    void check();
    const timer = setInterval(() => void check(), PROBE_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [verified]);

  return { online, linkUp, reportUnreachable, reportReachable };
}
