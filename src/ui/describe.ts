import type { Action, Effect, GameState, VariantDef } from '../engine';
import { areaById } from '../engine';

export function describeEffect(e: Effect): string {
  switch (e.t) {
    case 'fox':
      return '🦊 fox';
    case 'reroll':
      return '↻ re-roll';
    case 'plus1':
      return '+1 die';
    case 'return':
      return '↩ return';
    case 'crossAny':
      return `X in ${e.area}`;
    case 'crossNext':
      return `X next in ${e.area}`;
    case 'writeNext':
      return `${e.value} in ${e.area}`;
    case 'free':
      return `? in ${e.area}`;
    case 'silverMark':
      return `silver ${e.value}${e.row ? ` (${e.row} row)` : ' (any row)'}`;
    case 'choice':
      return e.options.map(describeEffect).join(' / ');
  }
}

function cellDesc(v: VariantDef, area: string, cell: number, value: number): string {
  const a = areaById(v, area);
  if (a.silverRows) {
    // Silver grid: cell = row (a color) × the value 1–6.
    const cols = a.size / a.silverRows.length;
    return `${a.label} ${(cell % cols) + 1} (${a.silverRows[Math.floor(cell / cols)]} row)`;
  }
  if (a.ui.kind === 'grid') {
    // Voids are either layout-only (ui has more cells than the engine, base
    // blue) or real always-empty cells (Twice yellow lattice) — see uiToEngine.
    const label =
      a.ui.cells.length === a.size
        ? a.ui.cells[cell]?.label
        : a.ui.cells.find((c, i) => !c.void && engineIndex(a.ui.cells, i) === cell)?.label;
    if (a.ui.twoState) {
      // Two-state lattice: the placement's value says which state it enters.
      return `${value === 1 ? 'circle' : 'cross'} ${a.label} ${label ?? ''}`.trim();
    }
    return `${a.label} ${label ?? ''}`.trim();
  }
  // Cross tracks mark a plain ✕; every other track writes the value down.
  const suffix = a.ui.crossTrack ? '' : ` = ${value}`;
  return `${a.label} slot ${cell + 1}${suffix}`;
}

/** Engine cell index of ui cell `uiIdx` (ui cells may contain layout voids). */
export function engineIndex(cells: { void?: boolean }[], uiIdx: number): number {
  let n = 0;
  for (let i = 0; i < uiIdx; i++) if (!cells[i].void) n++;
  return cells[uiIdx].void ? -1 : n;
}

/**
 * Engine cell index of ui cell `uiIdx` for an area of `size` engine cells.
 * When the ui has exactly `size` cells the voids are real (permanently empty)
 * engine cells and the mapping is the identity (Twice yellow lattice);
 * otherwise voids are layout-only and are compressed away (base blue).
 */
export function uiToEngine(
  cells: { void?: boolean }[],
  size: number,
  uiIdx: number,
): number {
  return cells.length === size ? uiIdx : engineIndex(cells, uiIdx);
}

export function describeAction(s: GameState, v: VariantDef, a: Action): string {
  const die = (i: number) => `${v.colors[i]} ${s.faces[i]}`;
  switch (a.t) {
    case 'pick':
      return a.placement
        ? `takes ${die(a.die)} → ${cellDesc(v, a.placement.area, a.placement.cell, a.placement.value)}`
        : `takes ${die(a.die)} (no mark)`;
    case 'skip':
      return 'forfeits the roll';
    case 'reroll':
      return 're-rolls';
    case 'return':
      return `returns ${die(a.die)} to the pool`;
    case 'proceed':
      return 'rolls on';
    case 'plus1':
      return `+1: ${die(a.die)} → ${cellDesc(v, a.placement.area, a.placement.cell, a.placement.value)}`;
    case 'endTurn':
      return s.phase === 'endTurn' ? 'ends active turn' : 'ends the round';
    case 'passivePick':
      return `platter: ${die(a.die)} → ${cellDesc(v, a.placement.area, a.placement.cell, a.placement.value)}`;
    case 'passiveSkip':
      return 'declines the platter';
    case 'bonus': {
      const head = s.pending[0];
      if (head?.t === 'crossAny' && a.cell !== undefined) {
        return `bonus X → ${cellDesc(v, head.area, a.cell, 1)}`;
      }
      if (head?.t === 'free' && a.placement) {
        return `? bonus → ${cellDesc(v, a.placement.area, a.placement.cell, a.placement.value)}`;
      }
      if (head?.t === 'silverMark' && a.placement) {
        return `chain mark → ${cellDesc(v, a.placement.area, a.placement.cell, a.placement.value)}`;
      }
      if (head?.t === 'choice' && a.option !== undefined) {
        return `bonus: ${describeEffect(head.options[a.option])}`;
      }
      return 'bonus';
    }
  }
}
