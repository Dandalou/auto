// Datové struktury předávané mezi workerem (stavba dlaždic) a hlavním vláknem.
// Všechny souřadnice jsou lokální vůči severozápadnímu rohu dlaždice v metrech.

export type TileKind = 'near' | 'far';

export interface TileRequest {
  id: number;
  kind: TileKind;
  z: number;
  x: number;
  y: number;
  tileUrl: string;
  texSize: number;
  treeBudget: number;
  /** Počet segmentů výškové mřížky blízké dlaždice (128 nebo 256). */
  n: number;
}

export interface MeshArrays {
  pos: Float32Array;
  nor: Float32Array;
  uv?: Float32Array;
  col?: Float32Array;
}

export interface RoadLine {
  cls: string;
  /** 1 = jednosměrka po směru, -1 = proti směru, 0 = obousměrná. */
  oneway: number;
  bridge: boolean;
  tunnel: boolean;
  /** x, y, z trojice (lokální). */
  pts: Float32Array;
}

export interface Colliders {
  /** Hrany budov: x1, z1, x2, z2, výška vrcholu (m n. m.). */
  edges: Float32Array;
  /** Kruhy (stromy): x, z, r. */
  circles: Float32Array;
  /** Mřížka cells×cells; položka >= 0 je hrana, < 0 je kruh (-1-index). */
  cells: number;
  cellStart: Int32Array;
  cellItems: Int32Array;
}

export interface NamedPoint {
  name: string;
  x: number;
  z: number;
}

export interface PlacePoint extends NamedPoint {
  cls: string;
}

export interface StreetLine {
  name: string;
  /** x, z dvojice. */
  pts: Float32Array;
}

export interface TileData {
  id: number;
  kind: TileKind;
  z: number;
  x: number;
  y: number;
  size: number;
  n: number;
  heights: Float32Array;
  terrain: MeshArrays;
  texture: ImageBitmap | null;
  walls?: MeshArrays;
  roofs?: MeshArrays;
  roadsMarked?: MeshArrays;
  roadsPlain?: MeshArrays;
  paths?: MeshArrays;
  bridgeSides?: MeshArrays;
  rails?: MeshArrays;
  /** Pouliční lampy: x, y, z. */
  lamps?: Float32Array;
  /** x, y, z, měřítko, druh (0 = jehličnan, 1 = listnáč, 2 = keř). */
  trees?: Float32Array;
  colliders?: Colliders;
  /** Mostovky: x1, z1, y1, x2, z2, y2, polovina šířky. */
  bridges?: Float32Array;
  roadLines?: RoadLine[];
  stops?: NamedPoint[];
  addresses?: NamedPoint[];
  places?: PlacePoint[];
  streets?: StreetLine[];
  /** Těžiště budov: x, z, obestavěný prostor (m³). */
  buildings?: Float32Array;
  error?: string;
}
