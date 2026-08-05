/**
 * Reusable area factories — the building blocks the Clever variants assemble
 * their sheets from.
 *
 * That's Pretty Clever:
 * - crossGridArea:      cross a cell matching a value, in any order; groups
 *                       (rows/columns/diagonals) grant bonuses or points
 *                       (yellow, blue — blue uses a value derived from two dice).
 * - thresholdTrackArea: cross left→right when the die meets the cell's
 *                       minimum (green).
 * - writeTrackArea:     write the die value left→right, with per-cell
 *                       multipliers and optionally bonus-gating minimum values
 *                       (orange; Twice pink).
 * - ascendTrackArea:    write strictly increasing values left→right, with a
 *                       reset value (purple).
 *
 * Twice as Clever:
 * - silverGridArea:     rows × the values 1–6, mark the value in any open row;
 *                       column completion grants bonuses, rows score by count.
 * - yellowLatticeArea:  two-state cells — circle a matching cell, then cross
 *                       it; groups complete once fully circled, crosses score.
 * - descendTrackArea:   write left→right, each value ≤ the previous one.
 * - pairsTrackArea:     write die × multiplier left→right; consecutive slot
 *                       pairs score first − second (can go negative).
 */
import type { AreaDef, AreaUi, DieColor, Effect, Faces, Placement } from './types';

interface BaseCfg {
  id: string;
  label: string;
  colors: DieColor[];
  /** Value derivation; default = face of the placed die. */
  effectiveValue?: (faces: Faces, die: DieColor) => number;
}

const defaultValue = (faces: Faces, die: DieColor) => faces[die];

export interface CrossGridCfg extends BaseCfg {
  /** Cell values; null = pre-printed cross. */
  values: (number | null)[];
  groups: { cells: number[]; kind: 'row' | 'col' | 'diag'; bonus?: Effect; points?: number }[];
  scoring: { kind: 'groupPoints' } | { kind: 'countTable'; table: number[] };
  ui?: Partial<AreaUi>;
}

export function crossGridArea(cfg: CrossGridCfg): AreaDef {
  const { values, groups } = cfg;
  return {
    id: cfg.id,
    label: cfg.label,
    colors: cfg.colors,
    size: values.length,
    init: () => values.map((v) => (v === null ? 1 : 0)),
    effectiveValue: cfg.effectiveValue ?? defaultValue,
    placements(cells, value) {
      const res: Placement[] = [];
      for (let i = 0; i < values.length; i++) {
        if (values[i] === value && cells[i] === 0) res.push({ area: cfg.id, cell: i, value: 1 });
      }
      return res;
    },
    apply(cells, p) {
      cells[p.cell] = 1;
      const effects: Effect[] = [];
      for (const g of groups) {
        if (g.bonus && g.cells.includes(p.cell) && g.cells.every((c) => cells[c] === 1)) {
          effects.push(g.bonus);
        }
      }
      return effects;
    },
    score(cells) {
      if (cfg.scoring.kind === 'groupPoints') {
        let pts = 0;
        for (const g of groups) {
          if (g.points && g.cells.every((c) => cells[c] === 1)) pts += g.points;
        }
        return pts;
      }
      let count = 0;
      for (let i = 0; i < values.length; i++) if (values[i] !== null && cells[i] === 1) count++;
      return cfg.scoring.table[count];
    },
    openCells(cells) {
      const res: number[] = [];
      for (let i = 0; i < values.length; i++) if (values[i] !== null && cells[i] === 0) res.push(i);
      return res;
    },
    bonusPlacement() {
      return null; // grids use crossAny, not crossNext/writeNext
    },
    freePlacements(cells) {
      // Free mark = cross any open cell.
      const res: Placement[] = [];
      for (let i = 0; i < values.length; i++) {
        if (values[i] !== null && cells[i] === 0) res.push({ area: cfg.id, cell: i, value: 1 });
      }
      return res;
    },
    ui: {
      kind: 'grid',
      columns: cfg.ui?.columns ?? 4,
      cells: values.map((v) => ({ label: v === null ? null : String(v), pre: v === null })),
      groups,
      pointsScale: cfg.scoring.kind === 'countTable' ? cfg.scoring.table.slice(1) : undefined,
      ...cfg.ui,
    },
  };
}

export interface ThresholdTrackCfg extends BaseCfg {
  thresholds: number[];
  /** Cumulative points by crossed count (index 0 = 0 crossed). */
  points: number[];
  cellBonuses?: Record<number, Effect>;
}

export function thresholdTrackArea(cfg: ThresholdTrackCfg): AreaDef {
  const n = cfg.thresholds.length;
  const bonuses = cfg.cellBonuses ?? {};
  const count = (cells: number[]) => {
    let c = 0;
    while (c < n && cells[c] === 1) c++;
    return c;
  };
  return {
    id: cfg.id,
    label: cfg.label,
    colors: cfg.colors,
    size: n,
    init: () => Array(n).fill(0),
    effectiveValue: cfg.effectiveValue ?? defaultValue,
    placements(cells, value) {
      const c = count(cells);
      if (c < n && value >= cfg.thresholds[c]) return [{ area: cfg.id, cell: c, value: 1 }];
      return [];
    },
    apply(cells, p) {
      cells[p.cell] = 1;
      const b = bonuses[p.cell];
      return b ? [b] : [];
    },
    score(cells) {
      return cfg.points[count(cells)];
    },
    openCells() {
      return [];
    },
    bonusPlacement(cells, kind) {
      if (kind !== 'cross') return null;
      const c = count(cells);
      return c < n ? { area: cfg.id, cell: c, value: 1 } : null;
    },
    freePlacements(cells) {
      // Free mark = cross the next cell, ignoring its threshold (green-X semantics).
      const c = count(cells);
      return c < n ? [{ area: cfg.id, cell: c, value: 1 }] : [];
    },
    ui: {
      kind: 'track',
      columns: n,
      cells: cfg.thresholds.map((t, i) => ({ label: `≥${t}`, bonus: bonuses[i] })),
      pointsScale: cfg.points.slice(1),
    },
  };
}

export interface WriteTrackCfg extends BaseCfg {
  multipliers: number[];
  cellBonuses?: Record<number, Effect>;
  /**
   * Minimum (un-multiplied) die value for a cell's bonus: writing below it
   * fills the slot but withholds the bonus (Twice pink). Cells without an
   * entry grant their bonus unconditionally.
   */
  bonusMinValues?: Record<number, number>;
}

export function writeTrackArea(cfg: WriteTrackCfg): AreaDef {
  const n = cfg.multipliers.length;
  const bonuses = cfg.cellBonuses ?? {};
  const gates = cfg.bonusMinValues ?? {};
  const next = (cells: number[]) => {
    let c = 0;
    while (c < n && cells[c] !== 0) c++;
    return c;
  };
  const write = (value: number, cell: number): Placement => ({
    area: cfg.id,
    cell,
    value: value * cfg.multipliers[cell],
  });
  return {
    id: cfg.id,
    label: cfg.label,
    colors: cfg.colors,
    size: n,
    init: () => Array(n).fill(0),
    effectiveValue: cfg.effectiveValue ?? defaultValue,
    placements(cells, value) {
      const c = next(cells);
      return c < n ? [write(value, c)] : [];
    },
    apply(cells, p) {
      cells[p.cell] = p.value;
      const b = bonuses[p.cell];
      if (!b) return [];
      const min = gates[p.cell];
      // The gate compares the un-multiplied die value against the printed minimum.
      if (min !== undefined && p.value / cfg.multipliers[p.cell] < min) return [];
      return [b];
    },
    score(cells) {
      return cells.reduce((a, b) => a + b, 0);
    },
    openCells() {
      return [];
    },
    bonusPlacement(cells, kind, value) {
      if (kind !== 'write' || value === undefined) return null;
      const c = next(cells);
      return c < n ? write(value, c) : null;
    },
    freePlacements(cells) {
      // Free write = any face value 1–6 in the next slot (multiplied as usual).
      const c = next(cells);
      if (c >= n) return [];
      return [1, 2, 3, 4, 5, 6].map((v) => write(v, c));
    },
    ui: {
      kind: 'track',
      columns: n,
      cells: cfg.multipliers.map((m, i) => ({
        label: m > 1 ? `×${m}` : gates[i] !== undefined ? `≥${gates[i]}` : null,
        bonus: bonuses[i],
      })),
    },
  };
}

export interface AscendTrackCfg extends BaseCfg {
  size: number;
  /** Writing this value lifts the ascending constraint for the next slot. */
  resetValue: number;
  cellBonuses?: Record<number, Effect>;
}

export function ascendTrackArea(cfg: AscendTrackCfg): AreaDef {
  const n = cfg.size;
  const bonuses = cfg.cellBonuses ?? {};
  const next = (cells: number[]) => {
    let c = 0;
    while (c < n && cells[c] !== 0) c++;
    return c;
  };
  const legal = (cells: number[], value: number) => {
    const c = next(cells);
    if (c >= n) return -1;
    const last = c === 0 ? 0 : cells[c - 1];
    return last === cfg.resetValue || value > last ? c : -1;
  };
  return {
    id: cfg.id,
    label: cfg.label,
    colors: cfg.colors,
    size: n,
    init: () => Array(n).fill(0),
    effectiveValue: cfg.effectiveValue ?? defaultValue,
    placements(cells, value) {
      const c = legal(cells, value);
      return c >= 0 ? [{ area: cfg.id, cell: c, value }] : [];
    },
    apply(cells, p) {
      cells[p.cell] = p.value;
      const b = bonuses[p.cell];
      return b ? [b] : [];
    },
    score(cells) {
      return cells.reduce((a, b) => a + b, 0);
    },
    openCells() {
      return [];
    },
    bonusPlacement(cells, kind, value) {
      if (kind !== 'write' || value === undefined) return null;
      const c = legal(cells, value);
      return c >= 0 ? { area: cfg.id, cell: c, value } : null;
    },
    freePlacements(cells) {
      // Free write = any face value 1–6 that respects the ascending rule.
      const res: Placement[] = [];
      for (let v = 1; v <= 6; v++) {
        const c = legal(cells, v);
        if (c >= 0) res.push({ area: cfg.id, cell: c, value: v });
      }
      return res;
    },
    ui: {
      kind: 'track',
      columns: n,
      cells: Array.from({ length: n }, (_, i) => ({
        label: null,
        bonus: bonuses[i],
        asc: i > 0,
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// Twice as Clever factories
// ---------------------------------------------------------------------------

export interface SilverGridCfg extends BaseCfg {
  /**
   * Row order, top to bottom; each row holds the values 1–6. The colors name
   * the rows so a row-restricted mark (silverMark) can address them.
   */
  rows: DieColor[];
  /** Column-completion bonus per value 1–6 (fires when every row has that value). */
  columnBonuses: Effect[];
  /** Cumulative points per row by mark count (index 0 = no marks). */
  points: number[];
}

/** Cell index of `value` (1–6) in row `row` of a silver grid (row-major layout). */
export function silverGridCell(row: number, value: number): number {
  return row * 6 + (value - 1);
}

/**
 * Twice silver: rows × the values 1–6; a die of value n marks n in any row
 * where it is still open. Completing a column (n marked in every row) grants
 * the column bonus; each row scores by its own mark count.
 */
export function silverGridArea(cfg: SilverGridCfg): AreaDef {
  const rows = cfg.rows.length;
  const size = rows * 6;
  const open = (cells: number[]) => {
    const res: number[] = [];
    for (let i = 0; i < size; i++) if (cells[i] === 0) res.push(i);
    return res;
  };
  return {
    id: cfg.id,
    label: cfg.label,
    colors: cfg.colors,
    size,
    init: () => Array(size).fill(0),
    effectiveValue: cfg.effectiveValue ?? defaultValue,
    placements(cells, value) {
      if (value < 1 || value > 6) return [];
      const res: Placement[] = [];
      for (let r = 0; r < rows; r++) {
        const c = silverGridCell(r, value);
        if (cells[c] === 0) res.push({ area: cfg.id, cell: c, value: 1 });
      }
      return res;
    },
    apply(cells, p) {
      cells[p.cell] = 1;
      const v = p.cell % 6;
      for (let r = 0; r < rows; r++) if (cells[r * 6 + v] === 0) return [];
      return [cfg.columnBonuses[v]];
    },
    score(cells) {
      let pts = 0;
      for (let r = 0; r < rows; r++) {
        let count = 0;
        for (let v = 0; v < 6; v++) if (cells[r * 6 + v] === 1) count++;
        pts += cfg.points[count];
      }
      return pts;
    },
    openCells: open,
    bonusPlacement() {
      return null;
    },
    freePlacements(cells) {
      // Silver ? = mark any open cell: any row, any value.
      return open(cells).map((cell) => ({ area: cfg.id, cell, value: 1 }));
    },
    ui: {
      kind: 'grid',
      columns: 6,
      scalePerRow: true,
      cells: Array.from({ length: size }, (_, i) => ({ label: String((i % 6) + 1) })),
      groups: cfg.columnBonuses.map((bonus, v) => ({
        kind: 'col' as const,
        cells: Array.from({ length: rows }, (_, r) => silverGridCell(r, v + 1)),
        bonus,
      })),
      pointsScale: cfg.points.slice(1),
    },
  };
}

export interface YellowLatticeCfg extends BaseCfg {
  /** Cell values in layout order; null = layout hole (no cell there). */
  values: (number | null)[];
  /** Groups complete — firing their bonus — once every cell is at least circled. */
  groups: { cells: number[]; kind: 'row' | 'col'; bonus?: Effect }[];
  /** Cumulative points by crossed count (index 0 = none crossed). */
  points: number[];
  ui?: Partial<AreaUi>;
}

/**
 * Twice yellow: two-state cells (0 empty → 1 circled → 2 crossed). A die of
 * value n circles an empty cell showing n or crosses a circled one. Groups
 * complete at state ≥ 1 (crossing is not required); only crosses score.
 */
export function yellowLatticeArea(cfg: YellowLatticeCfg): AreaDef {
  const { values, groups } = cfg;
  const marks = (cells: number[], value: number | null) => {
    // A cell below state 2 advances one state; the placement stores the new state.
    const res: Placement[] = [];
    for (let i = 0; i < values.length; i++) {
      if (values[i] !== null && (value === null || values[i] === value) && cells[i] < 2) {
        res.push({ area: cfg.id, cell: i, value: cells[i] + 1 });
      }
    }
    return res;
  };
  return {
    id: cfg.id,
    label: cfg.label,
    colors: cfg.colors,
    size: values.length,
    init: () => values.map(() => 0),
    effectiveValue: cfg.effectiveValue ?? defaultValue,
    placements(cells, value) {
      return marks(cells, value);
    },
    apply(cells, p) {
      cells[p.cell] = p.value;
      if (p.value !== 1) return []; // only a fresh circle can complete a group
      const effects: Effect[] = [];
      for (const g of groups) {
        if (g.bonus && g.cells.includes(p.cell) && g.cells.every((c) => cells[c] >= 1)) {
          effects.push(g.bonus);
        }
      }
      return effects;
    },
    score(cells) {
      let crossed = 0;
      for (const c of cells) if (c === 2) crossed++;
      return cfg.points[crossed];
    },
    openCells() {
      return []; // two-state cells don't support a plain crossAny
    },
    bonusPlacement() {
      return null;
    },
    freePlacements(cells) {
      // Yellow ? = circle any uncircled cell or cross any circled cell.
      return marks(cells, null);
    },
    ui: {
      kind: 'grid',
      columns: cfg.ui?.columns ?? 4,
      twoState: true,
      cells: values.map((v) => ({ label: v === null ? null : String(v), void: v === null })),
      groups,
      pointsScale: cfg.points.slice(1),
      ...cfg.ui,
    },
  };
}

export interface DescendTrackCfg extends BaseCfg {
  size: number;
  /** Writable value range (Twice blue: 2–12, from blue + white). */
  minValue: number;
  maxValue: number;
  /** Cumulative points by filled count (index 0 = empty). */
  points: number[];
  cellBonuses?: Record<number, Effect>;
}

/**
 * Twice blue: write left→right, each value ≤ the previous one. Scores by
 * filled count; a slot's bonus fires when it is written.
 */
export function descendTrackArea(cfg: DescendTrackCfg): AreaDef {
  const n = cfg.size;
  const bonuses = cfg.cellBonuses ?? {};
  const next = (cells: number[]) => {
    let c = 0;
    while (c < n && cells[c] !== 0) c++;
    return c;
  };
  const legal = (cells: number[], value: number) => {
    if (value < cfg.minValue || value > cfg.maxValue) return -1;
    const c = next(cells);
    if (c >= n) return -1;
    return c === 0 || value <= cells[c - 1] ? c : -1;
  };
  return {
    id: cfg.id,
    label: cfg.label,
    colors: cfg.colors,
    size: n,
    init: () => Array(n).fill(0),
    effectiveValue: cfg.effectiveValue ?? defaultValue,
    placements(cells, value) {
      const c = legal(cells, value);
      return c >= 0 ? [{ area: cfg.id, cell: c, value }] : [];
    },
    apply(cells, p) {
      cells[p.cell] = p.value;
      const b = bonuses[p.cell];
      return b ? [b] : [];
    },
    score(cells) {
      return cfg.points[next(cells)];
    },
    openCells() {
      return [];
    },
    bonusPlacement(cells, kind, value) {
      if (kind !== 'write' || value === undefined) return null;
      const c = legal(cells, value);
      return c >= 0 ? { area: cfg.id, cell: c, value } : null;
    },
    freePlacements(cells) {
      // Free write = any value in range that respects the descent (blue-? semantics).
      const res: Placement[] = [];
      for (let v = cfg.minValue; v <= cfg.maxValue; v++) {
        const c = legal(cells, v);
        if (c >= 0) res.push({ area: cfg.id, cell: c, value: v });
      }
      return res;
    },
    ui: {
      kind: 'track',
      columns: n,
      cells: Array.from({ length: n }, (_, i) => ({
        label: null,
        bonus: bonuses[i],
        desc: i > 0,
      })),
      pointsScale: cfg.points.slice(1),
    },
  };
}

export interface PairsTrackCfg extends BaseCfg {
  /** Per-slot multipliers; consecutive slots (0,1), (2,3), ... form the pairs (length must be even). */
  multipliers: number[];
  cellBonuses?: Record<number, Effect>;
}

/**
 * Twice green: write die × multiplier left→right. Each pair of consecutive
 * slots scores first − second once both are filled (an incomplete pair
 * scores 0, negative results stand), so the area total can be negative.
 */
export function pairsTrackArea(cfg: PairsTrackCfg): AreaDef {
  const n = cfg.multipliers.length;
  const bonuses = cfg.cellBonuses ?? {};
  const next = (cells: number[]) => {
    let c = 0;
    while (c < n && cells[c] !== 0) c++;
    return c;
  };
  const write = (value: number, cell: number): Placement => ({
    area: cfg.id,
    cell,
    value: value * cfg.multipliers[cell],
  });
  return {
    id: cfg.id,
    label: cfg.label,
    colors: cfg.colors,
    size: n,
    init: () => Array(n).fill(0),
    effectiveValue: cfg.effectiveValue ?? defaultValue,
    placements(cells, value) {
      const c = next(cells);
      return c < n ? [write(value, c)] : [];
    },
    apply(cells, p) {
      cells[p.cell] = p.value;
      const b = bonuses[p.cell];
      return b ? [b] : [];
    },
    score(cells) {
      let pts = 0;
      for (let i = 0; i + 1 < n; i += 2) {
        if (cells[i] !== 0 && cells[i + 1] !== 0) pts += cells[i] - cells[i + 1];
      }
      return pts;
    },
    openCells() {
      return [];
    },
    bonusPlacement(cells, kind, value) {
      if (kind !== 'write' || value === undefined) return null;
      const c = next(cells);
      return c < n ? write(value, c) : null;
    },
    freePlacements(cells) {
      // Green ? = choose a face 1–6, multiplied by the next slot as usual.
      const c = next(cells);
      if (c >= n) return [];
      return [1, 2, 3, 4, 5, 6].map((v) => write(v, c));
    },
    ui: {
      kind: 'track',
      columns: n,
      cells: cfg.multipliers.map((m, i) => ({
        label: `×${m}`,
        bonus: bonuses[i],
        pair: Math.floor(i / 2),
      })),
    },
  };
}
