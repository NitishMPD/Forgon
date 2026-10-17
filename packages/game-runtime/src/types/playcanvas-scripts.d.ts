// Ambient declaration for the engine's untyped ES-module script subpath. The Grid script ships
// as plain .mjs without type declarations, so we describe the pieces the runtime uses here.
// PlayCanvas scripts/* has no `types` condition in its package exports map.



declare module 'playcanvas/scripts/esm/grid.mjs' {
  import { Script } from 'playcanvas';
  export class Grid extends Script {
    static scriptName: string;
    /** 0 - one meter lines only. */
    static RESOLUTION_LOW: number;
    /** 1 - one meter and 10cm lines. */
    static RESOLUTION_MEDIUM: number;
    /** 2 - one meter, 10cm and 1cm lines. */
    static RESOLUTION_HIGH: number;
  }
}
