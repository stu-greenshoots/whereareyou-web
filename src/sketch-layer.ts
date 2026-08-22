import L from 'leaflet';
import type { Sketch } from '@whereareyou/protocol';
import { arrowHeadPoints } from './sketch-geometry.js';

/**
 * All Leaflet rendering for a sketch, kept out of Map.tsx so that file stays
 * readable. One handle per map; feed it sketches, it draws them.
 */

/**
 * The four inks, indexed by SketchColour. Chosen to be visibly distinct from
 * the two colours that already carry hard meaning on these maps — #2563eb
 * blue (the sharer's own position) and #d97706 amber (a third-party report) —
 * because a dispatcher confusing ink with a pin is the worst mix-up this
 * layer could invite. Ink itself carries NO meaning: rose is not hazard and
 * teal is not safe. Colour groups strokes; the note field carries meaning.
 */
export const SKETCH_INKS = ['#be185d', '#7c3aed', '#0f766e', '#1f2937'] as const;

const INK_WEIGHT = 3;
/** Every stroke sits on a white casing so it stays legible over any tile. */
const CASING = { color: '#ffffff', weight: INK_WEIGHT + 3, opacity: 0.85 } as const;
const HEAD_LENGTH_PX = 14;
const HEAD_SPREAD_RAD = 0.42;

export interface SketchHandle {
  update(sketch: Sketch | null): void;
  remove(): void;
}

export function attachSketch(map: L.Map, sketch: Sketch | null): SketchHandle {
  const group = L.layerGroup().addTo(map);

  // Arrowheads are sized in screen pixels, so their geographic footprint
  // changes with every zoom — without this they are a dot when zoomed out and
  // cover a street when zoomed in. Re-anchored on zoomend.
  let heads: Array<{ from: L.LatLng; to: L.LatLng; polygon: L.Polygon }> = [];

  const headLatLngs = (from: L.LatLng, to: L.LatLng): L.LatLng[] =>
    arrowHeadPoints(
      map.latLngToLayerPoint(from),
      map.latLngToLayerPoint(to),
      HEAD_LENGTH_PX,
      HEAD_SPREAD_RAD,
    ).map((p) => map.layerPointToLatLng(L.point(p.x, p.y)));

  const onZoomEnd = () => {
    for (const head of heads) head.polygon.setLatLngs(headLatLngs(head.from, head.to));
  };
  map.on('zoomend', onZoomEnd);

  const render = (next: Sketch | null): void => {
    group.clearLayers();
    heads = [];
    if (next === null) return;

    for (const shape of next.shapes) {
      const ink = SKETCH_INKS[shape.colour];

      if (shape.kind === 'pen') {
        const path = shape.points.map((p) => L.latLng(p.lat, p.lon));
        L.polyline(path, CASING).addTo(group);
        L.polyline(path, { color: ink, weight: INK_WEIGHT, opacity: 1 }).addTo(group);
      } else if (shape.kind === 'arrow') {
        const from = L.latLng(shape.from.lat, shape.from.lon);
        const to = L.latLng(shape.to.lat, shape.to.lon);
        L.polyline([from, to], CASING).addTo(group);
        L.polyline([from, to], { color: ink, weight: INK_WEIGHT, opacity: 1 }).addTo(group);
        const polygon = L.polygon(headLatLngs(from, to), {
          color: CASING.color,
          weight: 2,
          opacity: CASING.opacity,
          fillColor: ink,
          fillOpacity: 1,
        }).addTo(group);
        heads.push({ from, to, polygon });
      } else {
        const centre = L.latLng(shape.centre.lat, shape.centre.lon);
        L.circle(centre, { radius: shape.radiusM, ...CASING, fill: false }).addTo(group);
        L.circle(centre, {
          radius: shape.radiusM,
          color: ink,
          weight: INK_WEIGHT,
          fillColor: ink,
          fillOpacity: 0.08,
        }).addTo(group);
      }
    }
  };

  render(sketch);

  return {
    update: render,
    remove: () => {
      map.off('zoomend', onZoomEnd);
      group.remove();
    },
  };
}
