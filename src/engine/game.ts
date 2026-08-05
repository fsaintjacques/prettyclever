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
  BarKind,
  Effect,
  Faces,
  GameState,
  PendingNode,
  Placement,
  VariantDef,
} from './types';
import { silverGridCell } from './areas';
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

/** The variant's silver grid — the (unique) area flagged by silverRows. */
function silverAreaOf(v: VariantDef): AreaDef {
  const a = v.areas.find((x) => x.silverRows);
  if (!a) throw new Error('silverMark effect without a silver grid area');
  return a;
}

function effectResolvable(s: GameState, v: VariantDef, e: Effect): boolean {
  switch (e.t) {
    case 'crossAny':
      return areaById(v, e.area).openCells(s.areas[e.area]).length > 0;
    case 'crossNext':
      return areaById(v, e.area).bonusPlacement(s.areas[e.area], 'cross') !== null;
    case 'writeNext':
      return areaById(v, e.area).bonusPlacement(s.areas[e.area], 'write', e.value) !== null;
    case 'free':
      return areaById(v, e.area).freePlacements(s.areas[e.area]).length > 0;
    case 'silverMark': {
      const a = silverAreaOf(v);
      if (e.row === null) return a.placements(s.areas[a.id], e.value).length > 0;
      const r = a.silverRows!.indexOf(e.row);
      return r >= 0 && s.areas[a.id][silverGridCell(r, e.value)] === 0;
    }
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

/**
 * Unlock one reroll / +1 / return action. Every unlock also advances the
 * bar's cumulative counter: past the bar size the unlock is lost, and
 * circling the last slot fires the bar's end bonus (size 0 = no such bar on
 * the sheet, the counter never caps).
 */
function unlockBar(s: GameState, v: VariantDef, kind: BarKind): void {
  const bar = v.bars[kind];
  if (bar.size > 0 && s.barUnlocks[kind] >= bar.size) {
    s.stats.bonusesLost++;
    return;
  }
  s.barUnlocks[kind]++;
  if (kind === 'reroll') s.rerolls++;
  else if (kind === 'plus1') s.plus1++;
  else s.returns++;
  if (bar.size > 0 && s.barUnlocks[kind] === bar.size && bar.endBonus) {
    enqueueEffect(s, v, bar.endBonus, false);
  }
}

function enqueueEffect(s: GameState, v: VariantDef, e: Effect, front: boolean): void {
  /** Queue a decision effect (or count it lost when unresolvable). */
  const queueOrLose = () => {
    if (!effectResolvable(s, v, e)) s.stats.bonusesLost++;
    else if (front) s.pending.unshift(e);
    else s.pending.push(e);
  };
  switch (e.t) {
    case 'fox':
      s.foxes++;
      break;
    case 'reroll':
      unlockBar(s, v, 'reroll');
      break;
    case 'plus1':
      unlockBar(s, v, 'plus1');
      break;
    case 'return':
      unlockBar(s, v, 'return');
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
    case 'silverMark': {
      if (e.row === null) {
        // White/silver die: any row of the value — a row-choice decision.
        queueOrLose();
        break;
      }
      // Fixed row (a colored die's own row): applied on the spot, lost if the
      // cell is taken — never queued as a decision.
      const a = silverAreaOf(v);
      const r = a.silverRows!.indexOf(e.row);
      const cell = r >= 0 ? silverGridCell(r, e.value) : -1;
      if (cell >= 0 && s.areas[a.id][cell] === 0) {
        applyPlacementMut(s, v, { area: a.id, cell, value: 1 });
      } else {
        s.stats.bonusesLost++;
      }
      break;
    }
    case 'crossAny':
    case 'free':
    case 'choice': {
      queueOrLose();
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
  if (head.t === 'free') {
    return areaById(v, head.area)
      .freePlacements(s.areas[head.area])
      .map((placement) => ({ t: 'bonus', placement }) as Action);
  }
  if (head.t === 'silverMark') {
    // Only row-less marks are ever queued: choose among the value's open rows.
    const a = silverAreaOf(v);
    return a
      .placements(s.areas[a.id], head.value)
      .map((placement) => ({ t: 'bonus', placement }) as Action);
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
    case 'preRoll': {
      // Return window: take platter dice back into the pool, then roll.
      for (const die of platterDice(s)) acts.push({ t: 'return', die });
      acts.push({ t: 'proceed' });
      break;
    }
    case 'pick': {
      const pool = poolDice(s);
      if (s.rerolls > 0 && pool.length > 0) acts.push({ t: 'reroll' });
      let anyPlacement = false;
      for (const die of pool) {
        const ps = diePlacements(s, v, die);
        if (ps.length > 0) {
          anyPlacement = true;
          for (const p of ps) acts.push({ t: 'pick', die, placement: p });
        } else if (v.colors[die] !== 'silver') {
          // The silver die cannot be chosen when its value is exhausted
          // (explicit Twice rule) — no wasted-pick fallback for it.
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

/**
 * Enter the active turn's roll chance phase — through the preRoll return
 * window first when a return is unlocked and the platter is non-empty.
 * (Passive turns never route through here.)
 */
function toRollPhase(s: GameState): void {
  s.phase = s.returns > 0 && platterDice(s).length > 0 ? 'preRoll' : 'roll';
}

function afterPick(s: GameState, v: VariantDef): void {
  if (s.picks >= v.picksPerTurn || poolDice(s).length === 0) s.phase = 'endTurn';
  else toRollPhase(s);
}

/**
 * Platter chain (Twice silver): every die moved onto the platter by a pick
 * placed in the silver grid is also marked there. A colored die auto-marks
 * its own color's row (lost if taken); the wild die and the grid's own die
 * colors mark any row — queued ahead of the pick's other pending effects,
 * in die-index order among themselves.
 */
function enqueuePlatterChain(s: GameState, v: VariantDef, area: AreaDef, moved: number[]): void {
  const rowChoices: Effect[] = [];
  for (const die of moved) {
    const color = v.colors[die];
    const row = color === v.wild || area.colors.includes(color) ? null : color;
    const e: Effect = { t: 'silverMark', value: s.faces[die], row };
    if (row === null) rowChoices.push(e);
    else enqueueEffect(s, v, e, false); // fixed row: applied (or lost) on the spot
  }
  // Unshift in reverse so the row choices sit at the front in die order.
  for (let i = rowChoices.length - 1; i >= 0; i--) enqueueEffect(s, v, rowChoices[i], true);
}

function endTurnMut(s: GameState, v: VariantDef): void {
  if (s.phase === 'endTurn') {
    // Active turn done → passive turn.
    s.loc.fill('pool');
    if (v.plus1Scope === 'turn') s.plus1Used.fill(false); // 'round' keeps them until the round ends
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
      } else if (head.t === 'free' || head.t === 'silverMark') {
        if (!a.placement) throw new Error(`${head.t} needs a placement`);
        applyPlacementMut(s, v, a.placement);
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
      toRollPhase(s);
      break;
    }
    case 'return': {
      if (s.returns <= 0) throw new Error('no return available');
      if (s.loc[a.die] !== 'platter') throw new Error('returned die is not on the platter');
      s.loc[a.die] = 'pool';
      s.returns--;
      s.stats.returnsUsed++;
      // Stay in the window while both returns and platter dice remain.
      toRollPhase(s);
      break;
    }
    case 'proceed': {
      s.phase = 'roll';
      break;
    }
    case 'pick': {
      const f = s.faces[a.die];
      s.loc[a.die] = 'field';
      s.picks++;
      const moved: number[] = [];
      for (const die of poolDice(s)) {
        if (s.faces[die] < f) {
          s.loc[die] = 'platter';
          moved.push(die);
        }
      }
      if (a.placement) {
        applyPlacementMut(s, v, a.placement);
        const target = areaById(v, a.placement.area);
        if (target.silverRows) enqueuePlatterChain(s, v, target, moved);
      }
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
