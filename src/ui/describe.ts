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
  if (a.ui.kind === 'grid') {
    const label = a.ui.cells.find((c, i) => !c.void && engineIndex(a.ui.cells, i) === cell)?.label;
    return `${a.label} ${label ?? ''}`.trim();
  }
  const suffix = value > 1 || area === 'purple' || area === 'orange' ? ` = ${value}` : '';
  return `${a.label} slot ${cell + 1}${suffix}`;
}

/** Engine cell index of ui cell `uiIdx` (ui cells may contain layout voids). */
export function engineIndex(cells: { void?: boolean }[], uiIdx: number): number {
  let n = 0;
  for (let i = 0; i < uiIdx; i++) if (!cells[i].void) n++;
  return cells[uiIdx].void ? -1 : n;
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
      if (head?.t === 'choice' && a.option !== undefined) {
        return `bonus: ${describeEffect(head.options[a.option])}`;
      }
      return 'bonus';
    }
  }
}
