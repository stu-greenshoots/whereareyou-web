import { simplifyStroke } from '@whereareyou/protocol';
import type { SketchColour, SketchPoint, SketchShape } from '@whereareyou/protocol';

/**
 * The pure half of the drawing interaction: pointer positions in, shapes out.
 * Nothing here touches Leaflet or the DOM — deliberately, so this logic can
 * grow a test suite the day the phone trial surfaces a geometry bug, without
 * anything needing to be untangled first.
 */

export type DrawTool = 'pen' | 'arrow' | 'circle';

/** A gesture mid-flight. `points[0]` is where the pointer went down. */
export interface StrokeInProgress {
  tool: DrawTool;
  points: SketchPoint[];
}

export function beginStroke(tool: DrawTool, at: SketchPoint): StrokeInProgress {
  return { tool, points: [at] };
}

export function extendStroke(stroke: StrokeInProgress, at: SketchPoint): StrokeInProgress {
  // A pen accumulates its path; an arrow or circle only ever cares about
  // where the pointer is NOW relative to where it went down.
  if (stroke.tool === 'pen') return { tool: 'pen', points: [...stroke.points, at] };
  return { tool: stroke.tool, points: [stroke.points[0]!, at] };
}

/**
 * The shape to draw while the finger is still down. Relaxed thresholds — a
 * live preview should appear immediately, even for a stroke that would be
 * thrown away as degenerate if committed as-is.
 */
export function previewShape(
  stroke: StrokeInProgress,
  colour: SketchColour,
  metresBetween: (a: SketchPoint, b: SketchPoint) => number,
): SketchShape | null {
  const start = stroke.points[0]!;
  const end = stroke.points[stroke.points.length - 1]!;
  if (stroke.tool === 'pen') {
    return stroke.points.length >= 2 ? { kind: 'pen', colour, points: stroke.points } : null;
  }
  if (stroke.tool === 'arrow') {
    return stroke.points.length >= 2 ? { kind: 'arrow', colour, from: start, to: end } : null;
  }
  return { kind: 'circle', colour, centre: start, radiusM: metresBetween(start, end) };
}

/**
 * The shape to keep when the finger lifts, or null when the gesture was too
 * small to mean anything — a tap with the pen, a zero-length arrow, a
 * sub-metre circle. Dropping those here is what stops an accidental touch
 * becoming an invisible speck the dispatcher's decoder still has to carry.
 *
 * Pen strokes are simplified before committing, so what the caller sees on
 * their own map IS the geometry that travels — no silent simplification at
 * encode time.
 */
export function commitShape(
  stroke: StrokeInProgress,
  colour: SketchColour,
  metresBetween: (a: SketchPoint, b: SketchPoint) => number,
): SketchShape | null {
  const start = stroke.points[0]!;
  const end = stroke.points[stroke.points.length - 1]!;
  if (stroke.tool === 'pen') {
    const points = simplifyStroke(stroke.points);
    return points.length >= 2 ? { kind: 'pen', colour, points } : null;
  }
  if (stroke.tool === 'arrow') {
    if (stroke.points.length < 2 || metresBetween(start, end) < 2) return null;
    return { kind: 'arrow', colour, from: start, to: end };
  }
  const radiusM = metresBetween(start, end);
  return radiusM >= 1 ? { kind: 'circle', colour, centre: start, radiusM } : null;
}

export interface XY {
  x: number;
  y: number;
}

/**
 * The three corners of an arrowhead, in the same screen-pixel space as its
 * inputs: [one barb, the tip, the other barb]. Computed in pixels so the head
 * is a constant size on screen regardless of zoom — the caller of this is
 * responsible for recomputing when the zoom changes.
 */
export function arrowHeadPoints(from: XY, to: XY, lengthPx = 14, spreadRad = 0.42): [XY, XY, XY] {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const barb = (side: number): XY => ({
    x: to.x - lengthPx * Math.cos(angle + side * spreadRad),
    y: to.y - lengthPx * Math.sin(angle + side * spreadRad),
  });
  return [barb(1), { x: to.x, y: to.y }, barb(-1)];
}
