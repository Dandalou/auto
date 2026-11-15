// Výšková mřížka dlaždice. Stejná interpolace se používá ve workeru (stavba
// silnic) i v hlavním vlákně (fyzika), takže auto jede přesně po vykresleném terénu.

export interface HeightGrid {
  /** Počet segmentů na stranu (vrcholů je n+1). */
  n: number;
  /** Velikost dlaždice v metrech. */
  size: number;
  h: Float32Array;
}

/** Výška v lokálních souřadnicích dlaždice, nebo NaN mimo dlaždici. Interpoluje po trojúhelnících sítě. */
export function gridHeight(g: HeightGrid, lx: number, lz: number): number {
  const { n, size, h } = g;
  const fx = (lx / size) * n;
  const fz = (lz / size) * n;
  if (fx < 0 || fz < 0 || fx > n || fz > n) return NaN;
  let i = Math.floor(fx);
  let j = Math.floor(fz);
  if (i >= n) i = n - 1;
  if (j >= n) j = n - 1;
  const u = fx - i;
  const v = fz - j;
  const w = n + 1;
  const a = h[j * w + i];
  const b = h[j * w + i + 1];
  const c = h[(j + 1) * w + i];
  const d = h[(j + 1) * w + i + 1];
  // Triangulace: (a, c, b) a (b, c, d) – úhlopříčka b–c.
  if (u + v <= 1) return a + (b - a) * u + (c - a) * v;
  return d + (c - d) * (1 - u) + (b - d) * (1 - v);
}

/** Normála terénu (nenormalizovaný gradient) v lokálních souřadnicích. */
export function gridSlope(g: HeightGrid, lx: number, lz: number): { dx: number; dz: number } {
  const e = g.size / g.n;
  const h0 = gridHeight(g, lx, lz);
  let hx = gridHeight(g, lx + e * 0.5, lz);
  let hz = gridHeight(g, lx, lz + e * 0.5);
  if (Number.isNaN(hx)) hx = h0 - (gridHeight(g, lx - e * 0.5, lz) - h0);
  if (Number.isNaN(hz)) hz = h0 - (gridHeight(g, lx, lz - e * 0.5) - h0);
  return { dx: (hx - h0) / (e * 0.5), dz: (hz - h0) / (e * 0.5) };
}
