/**
 * Solo game state machine.
 *
 * The game advances through nodes reported by getPending():
 *   - { kind: 'chance' }   → call resolveChanceMut(state, variant, rng)
 *   - { kind: 'decision' } → pick one of `actions`, apply with applyAction[Mut]
 *   - { kind: 'over' }     → score with scoreState
 *
 * Pure wrappers (applyAction, resolveChance) clone; the *Mut versions mutate
 * the given state and exist for hot loops (simulations, rollouts).
 */
import type {
  Action,
  AreaDef,
  Effect,
  Faces,
  GameState,
  PendingNode,
  Placement,
  VariantDef,
} from './types';
import { rollD6, type RNG } from './rng';

export function areaById(v: VariantDef, id: string): AreaDef {
  const a = v.areas.find((x) => x.id === id);
  if (!a) throw new Error(`unknown area: ${id}`);
  return a;
}

export function newGame(v: VariantDef): GameState {
  const n = v.colors.length;
  const s: GameState = {
    variant: v.id,
    round: 1,
    phase: 'roll',
    faces: Array(n).fill(0),
    loc: Array(n).fill('pool'),
    picks: 0,
    rerolls: 0,
    plus1: 0,
    returns: 0,
    plus1Used: Array(n).fill(false),
    barUnlocks: { reroll: 0, plus1: 0, return: 0 },
    pending: [],
    areas: {},
    foxes: 0,
    stats: { rerollsUsed: 0, plus1Spent: 0, returnsUsed: 0, skips: 0, bonusesLost: 0 },
  };
  for (const a of v.areas) s.areas[a.id] = a.init();
  grantRoundBonus(s, v);
  return s;
}

export function cloneState(s: GameState): GameState {
  return {
    ...s,
    faces: s.faces.slice(),
    loc: s.loc.slice(),
    plus1Used: s.plus1Used.slice(),
    barUnlocks: { ...s.barUnlocks },
    pending: s.pending.slice(), // effects are immutable, sharing refs is fine
    areas: Object.fromEntries(Object.entries(s.areas).map(([k, cells]) => [k, cells.slice()])),
    stats: { ...s.stats },
  };
}

export function facesByColor(s: GameState, v: VariantDef): Faces {
  const f: Faces = {};
  for (let i = 0; i < v.colors.length; i++) f[v.colors[i]] = s.faces[i];
  return f;
}

/** All legal placements for die `die` in its current face value. */
export function diePlacements(s: GameState, v: VariantDef, die: number): Placement[] {
  const color = v.colors[die];
  const faces = facesByColor(s, v);
  const res: Placement[] = [];
  for (const area of v.areas) {
    if (!area.colors.includes(color) && color !== v.wild) continue;
    const value = area.effectiveValue(faces, color);
    if (value <= 0) continue;
    res.push(...area.placements(s.areas[area.id], value));
  }
  return res;
}

function poolDice(s: GameState): number[] {
  const res: number[] = [];
  for (let i = 0; i < s.loc.length; i++) if (s.loc[i] === 'pool') res.push(i);
  return res;
}

function platterDice(s: GameState): number[] {
  const res: number[] = [];
  for (let i = 0; i < s.loc.length; i++) if (s.loc[i] === 'platter') res.push(i);
  return res;
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

function effectResolvable(s: GameState, v: VariantDef, e: Effect): boolean {
  switch (e.t) {
    case 'crossAny':
      return areaById(v, e.area).openCells(s.areas[e.area]).length > 0;
    case 'crossNext':
      return areaById(v, e.area).bonusPlacement(s.areas[e.area], 'cross') !== null;
    case 'writeNext':
      return areaById(v, e.area).bonusPlacement(s.areas[e.area], 'write', e.value) !== null;
    case 'choice':
      return e.options.some((o) => effectResolvable(s, v, o));
    default:
      return true;
  }
}

/** Drop pending decisions that became unresolvable (their bonus is lost). */
function normalizePending(s: GameState, v: VariantDef): void {
  while (s.pending.length > 0 && !effectResolvable(s, v, s.pending[0])) {
    s.pending.shift();
    s.stats.bonusesLost++;
  }
}

function enqueueEffect(s: GameState, v: VariantDef, e: Effect, front: boolean): void {
  switch (e.t) {
    case 'fox':
      s.foxes++;
      break;
    case 'reroll':
      s.rerolls++;
      break;
    case 'plus1':
      s.plus1++;
      break;
    case 'crossNext': {
      const p = areaById(v, e.area).bonusPlacement(s.areas[e.area], 'cross');
      if (p) applyPlacementMut(s, v, p);
      else s.stats.bonusesLost++;
      break;
    }
    case 'writeNext': {
      const p = areaById(v, e.area).bonusPlacement(s.areas[e.area], 'write', e.value);
      if (p) applyPlacementMut(s, v, p);
      else s.stats.bonusesLost++;
      break;
    }
    case 'crossAny':
    case 'choice': {
      if (!effectResolvable(s, v, e)) {
        s.stats.bonusesLost++;
      } else if (front) {
        s.pending.unshift(e);
      } else {
        s.pending.push(e);
      }
      break;
    }
  }
}

/** Mark the sheet and resolve the resulting bonus cascade. */
function applyPlacementMut(s: GameState, v: VariantDef, p: Placement): void {
  const effects = areaById(v, p.area).apply(s.areas[p.area], p);
  for (const e of effects) enqueueEffect(s, v, e, false);
}

function grantRoundBonus(s: GameState, v: VariantDef): void {
  const b = v.roundBonuses[s.round - 1];
  if (b) enqueueEffect(s, v, b, false);
}

// ---------------------------------------------------------------------------
// Node inspection
// ---------------------------------------------------------------------------

export function getPending(s: GameState, v: VariantDef): PendingNode {
  if (s.phase === 'over') return { kind: 'over' };
  if (s.pending.length > 0) return { kind: 'decision', actions: bonusActions(s, v) };
  if (s.phase === 'roll' || s.phase === 'passiveRoll') return { kind: 'chance' };
  return { kind: 'decision', actions: legalActions(s, v) };
}

function bonusActions(s: GameState, v: VariantDef): Action[] {
  const head = s.pending[0];
  if (head.t === 'crossAny') {
    return areaById(v, head.area)
      .openCells(s.areas[head.area])
      .map((cell) => ({ t: 'bonus', cell }) as Action);
  }
  if (head.t === 'choice') {
    const acts: Action[] = [];
    head.options.forEach((o, i) => {
      if (effectResolvable(s, v, o)) acts.push({ t: 'bonus', option: i });
    });
    return acts;
  }
  throw new Error(`non-decision effect in pending queue: ${head.t}`);
}

function legalActions(s: GameState, v: VariantDef): Action[] {
  const acts: Action[] = [];
  switch (s.phase) {
    case 'pick': {
      const pool = poolDice(s);
      if (s.rerolls > 0 && pool.length > 0) acts.push({ t: 'reroll' });
      let anyPlacement = false;
      for (const die of pool) {
        const ps = diePlacements(s, v, die);
        if (ps.length > 0) {
          anyPlacement = true;
          for (const p of ps) acts.push({ t: 'pick', die, placement: p });
        } else {
          acts.push({ t: 'pick', die }); // wasted pick
        }
      }
      if (!anyPlacement) acts.push({ t: 'skip' });
      break;
    }
    case 'endTurn':
    case 'passiveEndTurn': {
      if (s.plus1 > 0) {
        for (let die = 0; die < s.loc.length; die++) {
          if (s.plus1Used[die]) continue;
          for (const p of diePlacements(s, v, die)) acts.push({ t: 'plus1', die, placement: p });
        }
      }
      acts.push({ t: 'endTurn' });
      break;
    }
    case 'passivePick': {
      for (const die of platterDice(s)) {
        for (const p of diePlacements(s, v, die)) acts.push({ t: 'passivePick', die, placement: p });
      }
      acts.push({ t: 'passiveSkip' });
      break;
    }
    default:
      throw new Error(`no legal actions in phase ${s.phase}`);
  }
  return acts;
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export function resolveChanceMut(s: GameState, v: VariantDef, rng: RNG): void {
  if (s.phase === 'roll') {
    for (const die of poolDice(s)) s.faces[die] = rollD6(rng);
    s.phase = 'pick';
  } else if (s.phase === 'passiveRoll') {
    for (let i = 0; i < s.loc.length; i++) {
      s.loc[i] = 'pool';
      s.faces[i] = rollD6(rng);
    }
    // Three lowest dice go to the platter; ties broken randomly.
    const order = s.faces
      .map((f, i) => ({ f, i, r: rng() }))
      .sort((a, b) => a.f - b.f || a.r - b.r);
    for (let k = 0; k < 3; k++) s.loc[order[k].i] = 'platter';
    s.phase = 'passivePick';
  } else {
    throw new Error(`resolveChance in phase ${s.phase}`);
  }
}

export function resolveChance(s: GameState, v: VariantDef, rng: RNG): GameState {
  const ns = cloneState(s);
  resolveChanceMut(ns, v, rng);
  return ns;
}

function afterPick(s: GameState, v: VariantDef): void {
  if (s.picks >= v.picksPerTurn || poolDice(s).length === 0) s.phase = 'endTurn';
  else s.phase = 'roll';
}

function endTurnMut(s: GameState, v: VariantDef): void {
  if (s.phase === 'endTurn') {
    // Active turn done → passive turn.
    s.loc.fill('pool');
    s.plus1Used.fill(false);
    s.phase = 'passiveRoll';
  } else {
    // Passive turn done → next round or game over.
    if (s.round >= v.rounds) {
      s.phase = 'over';
      return;
    }
    s.round++;
    s.picks = 0;
    s.loc.fill('pool');
    s.plus1Used.fill(false);
    s.phase = 'roll';
    grantRoundBonus(s, v);
  }
}

export function applyActionMut(s: GameState, v: VariantDef, a: Action): void {
  switch (a.t) {
    case 'bonus': {
      const head = s.pending.shift();
      if (!head) throw new Error('bonus action without pending bonus');
      if (head.t === 'crossAny') {
        if (a.cell === undefined) throw new Error('crossAny needs a cell');
        applyPlacementMut(s, v, { area: head.area, cell: a.cell, value: 1 });
      } else if (head.t === 'choice') {
        if (a.option === undefined) throw new Error('choice needs an option');
        enqueueEffect(s, v, head.options[a.option], true);
      } else {
        throw new Error(`cannot resolve pending effect ${head.t}`);
      }
      break;
    }
    case 'reroll': {
      if (s.rerolls <= 0) throw new Error('no reroll available');
      s.rerolls--;
      s.stats.rerollsUsed++;
      s.phase = 'roll';
      break;
    }
    case 'pick': {
      const f = s.faces[a.die];
      s.loc[a.die] = 'field';
      s.picks++;
      for (const die of poolDice(s)) {
        if (s.faces[die] < f) s.loc[die] = 'platter';
      }
      if (a.placement) applyPlacementMut(s, v, a.placement);
      afterPick(s, v);
      break;
    }
    case 'skip': {
      s.picks++;
      s.stats.skips++;
      afterPick(s, v);
      break;
    }
    case 'plus1': {
      if (s.plus1 <= 0) throw new Error('no +1 available');
      s.plus1--;
      s.stats.plus1Spent++;
      s.plus1Used[a.die] = true;
      applyPlacementMut(s, v, a.placement);
      break;
    }
    case 'endTurn': {
      endTurnMut(s, v);
      break;
    }
    case 'passivePick': {
      applyPlacementMut(s, v, a.placement);
      s.phase = 'passiveEndTurn';
      break;
    }
    case 'passiveSkip': {
      s.phase = 'passiveEndTurn';
      break;
    }
  }
  normalizePending(s, v);
}

export function applyAction(s: GameState, v: VariantDef, a: Action): GameState {
  const ns = cloneState(s);
  applyActionMut(ns, v, a);
  return ns;
}
