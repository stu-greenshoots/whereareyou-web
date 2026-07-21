/// <reference types="vite-plugin-pwa/client" />
/**
 * Minimal ambient declarations for two geo libraries that ship no types.
 *
 * These describe only the surface we use, and each signature was verified
 * against real output rather than guessed — Trafalgar Square and Ben Nevis both
 * round-trip to their published OS grid references.
 */

declare module 'open-location-code' {
  export class OpenLocationCode {
    /** @param codeLength 11 gives ~3m resolution. */
    encode(latitude: number, longitude: number, codeLength?: number): string;
    decode(code: string): {
      latitudeCenter: number;
      longitudeCenter: number;
      latitudeLo: number;
      longitudeLo: number;
      latitudeHi: number;
      longitudeHi: number;
      codeLength: number;
    };
    isValid(code: string): boolean;
    isFull(code: string): boolean;
  }

  const _default: { OpenLocationCode: typeof OpenLocationCode };
  export default _default;
}

declare module 'geodesy/osgridref.js' {
  export default class OsGridRef {
    constructor(easting: number, northing: number);
    easting: number;
    northing: number;
    /** `digits: 0` yields raw `easting,northing`; 10 (default) yields `TQ 30020 80456`. */
    toString(digits?: number): string;
    static parse(gridref: string): OsGridRef;
  }

  export class LatLon {
    constructor(lat: number, lon: number, height?: number);
    lat: number;
    lon: number;
    /** Throws if the position is outside the OSGB36 coverage area. */
    toOsGrid(): OsGridRef;
  }
}
