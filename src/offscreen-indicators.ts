import L from 'leaflet';

/**
 * Off-screen indicators for PLACED MARKERS and ZONES — the edge pills that
 * answer "where did everything go?" when a pan or zoom walks the caller's
 * claims out of the viewport. One handle per map, fed the current object
 * list: on every camera move (rAF-throttled) it projects each object, and
 * any whose position lies outside the viewport gets a compact pill hugging
 * the map edge where the line from the viewport centre to the object
 * crosses it, its arrow rotated to point at the object itself.
 *
 * Markers and zones ONLY. They are claims about the world — they hold
 * still, so pointing at them from the edge is honest. People (peer dots,
 * the self pin) never get one: a pill claiming "someone is that way" goes
 * stale the moment they move, and the roster is the place to find people.
 *
 * Kept out of Map.tsx for the same reason as sketch-layer.ts: this is
 * imperative per-frame DOM work, not React state. Pills are pooled by
 * object id and their content (and measured size) is rebuilt only when it
 * changes, so a pan frame costs projections and two transform writes per
 * pill. When everything is on-screen the layer is hidden and the per-frame
 * cost is the projections alone; when the map has no size (hidden), nothing
 * runs at all.
 */

export interface OffscreenTarget {
  id: string;
  kind: 'marker' | 'zone';
  lat: number;
  lon: number;
  /**
   * Markers only: what goes inside the mini diamond. TRUSTED HTML — the
   * caller builds it from the MARKER_GLYPHS table or a regex-vetted single
   * character, never from raw wire text.
   */
  glyphHtml?: string;
  /** The object's name — raw wire text, rendered via textContent only. */
  name: string;
}

export interface OffscreenIndicatorsOptions {
  /** A pill was tapped: navigate to its object. */
  onTap(target: OffscreenTarget): void;
  /** A "+N" cluster pill was tapped: bring the lot into view. */
  onTapCluster(targets: OffscreenTarget[]): void;
}

export interface OffscreenIndicatorsHandle {
  update(targets: OffscreenTarget[]): void;
  remove(): void;
}

/** Air between a pill and the map's own edge. */
const EDGE_INSET = 10;
/** Pills never enter the corner boxes, so runs on adjacent edges can't meet. */
const CORNER_PAD = 40;
/** Air between pills stacked along one edge. */
const PILL_GAP = 6;
/** Breathing room added around a floating control when steering past it. */
const KEEPOUT_PAD = 6;
/** How deep the strip along an edge reaches when testing whether a floating
    control is in the way (widest pill ≈ 150px on the vertical edges). */
const EDGE_BAND = 150;
/** Horizontal-edge pills are only pill-height deep. */
const EDGE_BAND_THIN = 40;
/** Names longer than this stay off the pill — glyph and arrow still carry
    it, and the full name rides in the accessible label. */
const NAME_MAX_CHARS = 14;

const ARROW_SVG =
  '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1.5 6h8M6.2 2.5 9.7 6 6.2 9.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
/** The zone motif: the dashed circle the zone itself is drawn as. */
const ZONE_SVG =
  '<svg viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="5.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.6 2.6"/></svg>';

type Edge = 'top' | 'right' | 'bottom' | 'left';

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface Pill {
  el: HTMLButtonElement;
  arrow: HTMLElement;
  contentKey: string;
  w: number;
  h: number;
  /** What a tap means right now — one target, or a cluster's list. */
  targets: OffscreenTarget[];
}

export function attachOffscreenIndicators(
  map: L.Map,
  options: OffscreenIndicatorsOptions,
): OffscreenIndicatorsHandle {
  const container = map.getContainer();
  const layer = document.createElement('div');
  layer.className = 'osi-layer';
  layer.style.display = 'none';
  container.appendChild(layer);

  let targets: OffscreenTarget[] = [];
  const pool = new Map<string, Pill>();
  let raf = 0;
  let timer = 0;

  const acquire = (key: string): Pill => {
    const existing = pool.get(key);
    if (existing !== undefined) return existing;
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'osi-pill';
    // Taps belong to the pill: never let them fall through to the map,
    // where they would place a marker, move the pin, or start a stroke.
    L.DomEvent.disableClickPropagation(el);
    el.addEventListener('pointerdown', (event) => event.stopPropagation());
    const pill: Pill = { el, arrow: el, contentKey: '', w: 0, h: 0, targets: [] };
    el.addEventListener('click', (event) => {
      event.stopPropagation();
      const list = pill.targets;
      const only = list[0];
      if (list.length === 1 && only !== undefined) options.onTap(only);
      else if (list.length > 1) options.onTapCluster(list);
    });
    layer.appendChild(el);
    pool.set(key, pill);
    return pill;
  };

  /** Rebuild a pill's content when it changed; sizes are measured here and
      nowhere else, so a pan frame never touches layout. */
  const syncSingle = (pill: Pill, target: OffscreenTarget): void => {
    const shownName = target.name.length <= NAME_MAX_CHARS ? target.name : '';
    const key = `1|${target.kind}|${target.glyphHtml ?? ''}|${target.name}`;
    if (pill.contentKey === key) return;
    pill.contentKey = key;
    const motif =
      target.kind === 'zone'
        ? `<span class="osi-zone" aria-hidden="true">${ZONE_SVG}</span>`
        : `<span class="osi-diamond" aria-hidden="true"><span class="osi-glyph">${target.glyphHtml ?? ''}</span></span>`;
    pill.el.innerHTML = `${motif}<span class="osi-name"></span><span class="osi-arrow" aria-hidden="true">${ARROW_SVG}</span>`;
    const nameEl = pill.el.querySelector('.osi-name');
    if (nameEl instanceof HTMLElement) {
      if (shownName === '') nameEl.remove();
      else nameEl.textContent = shownName; // raw wire text — textContent only
    }
    const arrow = pill.el.querySelector('.osi-arrow');
    pill.arrow = arrow instanceof HTMLElement ? arrow : pill.el;
    pill.el.setAttribute(
      'aria-label',
      target.kind === 'zone'
        ? `Go to the zone “${target.name}”`
        : target.name !== ''
          ? `Go to “${target.name}”`
          : 'Go to the marked spot',
    );
    pill.w = pill.el.offsetWidth;
    pill.h = pill.el.offsetHeight;
  };

  const syncCluster = (pill: Pill, count: number): void => {
    const key = `c|${count}`;
    if (pill.contentKey === key) return;
    pill.contentKey = key;
    pill.el.innerHTML = `<span class="osi-name"></span><span class="osi-arrow" aria-hidden="true">${ARROW_SVG}</span>`;
    const nameEl = pill.el.querySelector('.osi-name');
    if (nameEl instanceof HTMLElement) nameEl.textContent = `+${count}`;
    const arrow = pill.el.querySelector('.osi-arrow');
    pill.arrow = arrow instanceof HTMLElement ? arrow : pill.el;
    pill.el.setAttribute('aria-label', `Show ${count} more off the map this way`);
    pill.w = pill.el.offsetWidth;
    pill.h = pill.el.offsetHeight;
  };

  const hide = (): void => {
    if (layer.style.display !== 'none') layer.style.display = 'none';
  };

  const recompute = (): void => {
    const size = map.getSize();
    const w = size.x;
    const h = size.y;
    if (w === 0 || h === 0 || targets.length === 0) {
      hide();
      return;
    }

    // Everything on-screen is the common case — find out cheaply first.
    const off: Array<{ target: OffscreenTarget; x: number; y: number }> = [];
    for (const target of targets) {
      const pt = map.latLngToContainerPoint([target.lat, target.lon]);
      if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) continue;
      if (pt.x >= 0 && pt.x <= w && pt.y >= 0 && pt.y <= h) continue;
      off.push({ target, x: pt.x, y: pt.y });
    }
    if (off.length === 0) {
      hide();
      return;
    }
    layer.style.display = '';

    // The inset rect pills live on: clear of the map edge itself and of the
    // bottom overlay stack (toolbar, sheets, the live bar). The coverage is
    // capped so the viewport centre — where every ray is cast from — always
    // stays inside the rect.
    const frame = container.parentElement;
    const stack = frame?.querySelector('.map-bottom-stack');
    const covered =
      stack instanceof HTMLElement ? Math.min(stack.offsetHeight + 8, Math.round(h * 0.45)) : 0;
    const rect: Rect = {
      left: EDGE_INSET,
      top: EDGE_INSET,
      right: w - EDGE_INSET,
      bottom: h - EDGE_INSET - covered,
    };
    if (rect.right - rect.left < 2 * CORNER_PAD + 20 || rect.bottom - rect.top < 2 * CORNER_PAD + 20) {
      hide(); // a map too small for edge furniture is better bare
      return;
    }

    // Floating controls to steer around — re-measured each pass because
    // control stacks and sheets come and go (a handful of rects, cheap).
    const containerBox = container.getBoundingClientRect();
    const keepOuts: Rect[] = [];
    const scope = frame?.parentElement ?? frame ?? container;
    for (const el of scope.querySelectorAll(
      '.map-locate, .map-close-pill, .profile-float, .leaflet-control-zoom',
    )) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      keepOuts.push({
        left: box.left - containerBox.left - KEEPOUT_PAD,
        top: box.top - containerBox.top - KEEPOUT_PAD,
        right: box.right - containerBox.left + KEEPOUT_PAD,
        bottom: box.bottom - containerBox.top + KEEPOUT_PAD,
      });
    }

    const cx = w / 2;
    const cy = h / 2;

    interface Item {
      target: OffscreenTarget;
      objX: number;
      objY: number;
      along: number;
    }
    const byEdge: Record<Edge, Item[]> = { top: [], right: [], bottom: [], left: [] };

    for (const entry of off) {
      const dx = entry.x - cx;
      const dy = entry.y - cy;
      // Where the centre→object ray crosses the inset rect: the nearest of
      // the two slab exits it can reach.
      let t = Infinity;
      let edge: Edge = 'right';
      if (dx > 0) {
        const tx = (rect.right - cx) / dx;
        if (tx < t) {
          t = tx;
          edge = 'right';
        }
      } else if (dx < 0) {
        const tx = (rect.left - cx) / dx;
        if (tx < t) {
          t = tx;
          edge = 'left';
        }
      }
      if (dy > 0) {
        const ty = (rect.bottom - cy) / dy;
        if (ty < t) {
          t = ty;
          edge = 'bottom';
        }
      } else if (dy < 0) {
        const ty = (rect.top - cy) / dy;
        if (ty < t) {
          t = ty;
          edge = 'top';
        }
      }
      if (!Number.isFinite(t)) continue;
      const along = edge === 'left' || edge === 'right' ? cy + dy * t : cx + dx * t;
      byEdge[edge].push({ target: entry.target, objX: entry.x, objY: entry.y, along });
    }

    const usedKeys = new Set<string>();

    for (const edge of ['top', 'right', 'bottom', 'left'] as const) {
      const items = byEdge[edge];
      if (items.length === 0) continue;
      const vertical = edge === 'left' || edge === 'right';

      // The stretch of edge this run may occupy: inside the corner boxes,
      // and clear of any floating control parked against this edge. All the
      // known controls hug an end of their edge, so a keep-out only ever
      // trims the range, never splits it.
      const rangeLo = (vertical ? rect.top : rect.left) + CORNER_PAD;
      const rangeHi = (vertical ? rect.bottom : rect.right) - CORNER_PAD;
      let a0 = rangeLo;
      let a1 = rangeHi;
      const mid = (a0 + a1) / 2;
      for (const ko of keepOuts) {
        const inBand = vertical
          ? edge === 'right'
            ? ko.right >= rect.right - EDGE_BAND
            : ko.left <= rect.left + EDGE_BAND
          : edge === 'top'
            ? ko.top <= rect.top + EDGE_BAND_THIN
            : ko.bottom >= rect.bottom - EDGE_BAND_THIN;
        if (!inBand) continue;
        const koLo = vertical ? ko.top : ko.left;
        const koHi = vertical ? ko.bottom : ko.right;
        if (koHi <= a0 || koLo >= a1) continue;
        if ((koLo + koHi) / 2 < mid) a0 = Math.max(a0, koHi);
        else a1 = Math.min(a1, koLo);
      }
      if (a1 - a0 < 30) {
        // Controls squeezed the range to nothing (a short console map).
        // A pill under a control still beats an invisible one — the
        // controls draw on top and stay usable.
        a0 = rangeLo;
        a1 = rangeHi;
      }

      items.sort((a, b) => a.along - b.along);
      const singles = items.map((item) => {
        const pill = acquire(item.target.id);
        syncSingle(pill, item.target);
        return { item, pill, extent: vertical ? pill.h : pill.w };
      });

      // Crowded edge: keep what fits and fold the rest into one "+N" pill
      // at the far end of the run.
      const avail = a1 - a0;
      const total =
        singles.reduce((sum, s) => sum + s.extent, 0) + PILL_GAP * (singles.length - 1);
      let keep = singles.length;
      let clusterPill: Pill | null = null;
      let clustered: Item[] = [];
      if (total > avail) {
        clusterPill = acquire(`cluster:${edge}`);
        syncCluster(clusterPill, singles.length); // worst-case width first
        const clusterExtent = vertical ? clusterPill.h : clusterPill.w;
        let used = clusterExtent;
        keep = 0;
        for (const s of singles) {
          const next = used + PILL_GAP + s.extent;
          if (next > avail) break;
          used = next;
          keep += 1;
        }
        clustered = singles.slice(keep).map((s) => s.item);
        if (clustered.length === 0) {
          keep = singles.length;
          clusterPill = null; // it fit after all — the pool pass reclaims it
        } else {
          syncCluster(clusterPill, clustered.length);
        }
      }

      interface Placed {
        pill: Pill;
        extent: number;
        along: number;
        item?: Item;
        clustered?: Item[];
      }
      const placed: Placed[] = singles
        .slice(0, keep)
        .map((s) => ({ pill: s.pill, extent: s.extent, along: s.item.along, item: s.item }));
      if (clusterPill !== null && clustered.length > 0) {
        placed.push({
          pill: clusterPill,
          extent: vertical ? clusterPill.h : clusterPill.w,
          along: a1,
          clustered,
        });
      }

      // Greedy forward sweep, then a backward pass to pull the run inside
      // the range — capacity is already guaranteed, so both passes settle.
      let prevEnd = -Infinity;
      for (const p of placed) {
        const desired = Math.min(Math.max(p.along, a0 + p.extent / 2), a1 - p.extent / 2);
        p.along = Math.max(desired, prevEnd + PILL_GAP + p.extent / 2);
        prevEnd = p.along + p.extent / 2;
      }
      for (let i = placed.length - 1; i >= 0; i -= 1) {
        const p = placed[i]!;
        const hi =
          i === placed.length - 1
            ? a1 - p.extent / 2
            : placed[i + 1]!.along - placed[i + 1]!.extent / 2 - PILL_GAP - p.extent / 2;
        if (p.along > hi) p.along = hi;
      }

      for (const p of placed) {
        const pill = p.pill;
        let x: number;
        let y: number;
        if (edge === 'right') {
          x = rect.right - pill.w / 2;
          y = p.along;
        } else if (edge === 'left') {
          x = rect.left + pill.w / 2;
          y = p.along;
        } else if (edge === 'top') {
          x = p.along;
          y = rect.top + pill.h / 2;
        } else {
          x = p.along;
          y = rect.bottom - pill.h / 2;
        }

        // The arrow points from where the pill ACTUALLY sits to the object —
        // truthful even after nudges and clamps moved the pill off the ray.
        let toX: number;
        let toY: number;
        if (p.item !== undefined) {
          pill.targets = [p.item.target];
          toX = p.item.objX;
          toY = p.item.objY;
          usedKeys.add(p.item.target.id);
        } else {
          const list = p.clustered ?? [];
          pill.targets = list.map((item) => item.target);
          toX = list.reduce((sum, item) => sum + item.objX, 0) / list.length;
          toY = list.reduce((sum, item) => sum + item.objY, 0) / list.length;
          usedKeys.add(`cluster:${edge}`);
        }
        const angle = (Math.atan2(toY - y, toX - x) * 180) / Math.PI;
        pill.el.style.transform = `translate(${Math.round(x - pill.w / 2)}px, ${Math.round(y - pill.h / 2)}px)`;
        pill.arrow.style.transform = `rotate(${Math.round(angle)}deg)`;
      }
    }

    // An object back in view, gone from the list, or folded into a cluster
    // takes its pill with it.
    for (const [key, pill] of pool) {
      if (!usedKeys.has(key)) {
        pill.el.remove();
        pool.delete(key);
      }
    }
  };

  /**
   * One recompute per frame while visible — rAF coalesces a pan's stream of
   * `move` events. But a HIDDEN page (background tab, occluded or minimised
   * window — a sleeping laptop's whole desktop counts) never fires rAF at
   * all, and a callback queued there just hangs: live updates would arrive,
   * update() would land, and the layer would still show the old world the
   * moment the page is next looked at (or screenshotted — this exact hang
   * ate a debugging session). Timeouts DO fire on hidden pages, so hidden
   * work falls back to one of those; the work is a handful of projections,
   * cheap enough to keep the layer truthful sight-unseen.
   */
  const schedule = (): void => {
    if (document.visibilityState === 'hidden') {
      if (raf !== 0) {
        // Queued while visible, but it will never fire now — replace it.
        cancelAnimationFrame(raf);
        raf = 0;
      }
      if (timer !== 0) return;
      timer = window.setTimeout(() => {
        timer = 0;
        recompute();
      }, 0);
      return;
    }
    // A pending timeout still fires when the page is visible — let it.
    if (raf !== 0 || timer !== 0) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      recompute();
    });
  };

  map.on('move zoom zoomend moveend resize viewreset', schedule);

  return {
    update(next) {
      targets = next;
      schedule();
    },
    remove() {
      map.off('move zoom zoomend moveend resize viewreset', schedule);
      if (raf !== 0) cancelAnimationFrame(raf);
      if (timer !== 0) window.clearTimeout(timer);
      layer.remove();
      pool.clear();
    },
  };
}
