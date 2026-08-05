/**
 * Reusable area factories. The four kinds below cover the standard sheet and
 * are the building blocks for other Clever variants:
 *
 * - crossGridArea:      cross a cell matching a value, in any order; groups
 *                       (rows/columns/diagonals) grant bonuses or points
 *                       (yellow, blue — blue uses a value derived from two dice).
 * - thresholdTrackArea: cross left→right when the die meets the cell's
 *                       minimum (green).
 * - writeTrackArea:     write the die value left→right, with per-cell
 *                       multipliers (orange).
 * - ascendTrackArea:    write strictly increasing values left→right, with a
 *                       reset value (purple).
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
}

export function writeTrackArea(cfg: WriteTrackCfg): AreaDef {
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
    ui: {
      kind: 'track',
      columns: n,
      cells: cfg.multipliers.map((m, i) => ({
        label: m > 1 ? `×${m}` : null,
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
