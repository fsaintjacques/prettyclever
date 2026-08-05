/**
 * Core types for the Clever engine.
 *
 * The engine models a solo game as an explicit sequential decision process:
 * decision nodes (enumerable legal actions) alternate with chance nodes
 * (dice rolls, driven by an injectable RNG), which makes it directly usable
 * by search algorithms (greedy, Monte-Carlo, expectimax, RL, ...).
 */

export type DieColor =
  | 'white'
  | 'yellow'
  | 'blue'
  | 'green'
  | 'orange'
  | 'purple'
  | 'pink'
  | 'silver';

/** Where a die currently sits during a turn. */
export type Loc = 'pool' | 'platter' | 'field';

/** Current face value per die color. */
export type Faces = Record<string, number>;

/**
 * An effect is anything a cell/row/column bonus can grant. Effects either
 * resolve automatically (fox, reroll, plus1, return, crossNext, writeNext,
 * silverMark with a fixed row) or require a player decision (crossAny, free,
 * silverMark without a row, choice) and are queued as pending decisions.
 */
export type Effect =
  | { t: 'fox' }
  | { t: 'reroll' }
  | { t: 'plus1' }
  /** Unlock one return action (Twice: take a platter die back before a roll). */
  | { t: 'return' }
  /** Cross any open cell of the given area (yellow X / blue X bonuses). */
  | { t: 'crossAny'; area: string }
  /** Cross the next cell of an ordered area, ignoring entry requirements (green X). */
  | { t: 'crossNext'; area: string }
  /** Write a fixed number in the next slot of an ordered area (orange 4/5/6, purple 6). */
  | { t: 'writeNext'; area: string; value: number }
  /** Colored ?: any mark the area's freePlacements offers (Twice bonuses). */
  | { t: 'free'; area: string }
  /**
   * Platter-chain mark in the silver area (Twice): mark `value` in the row of
   * die color `row` (auto-applied; lost if that cell is taken), or — for the
   * white/silver die, `row: null` — in any row of the player's choice.
   */
  | { t: 'silverMark'; value: number; row: DieColor | null }
  /** Player chooses one of several effects (round-4 black X | black 6). */
  | { t: 'choice'; options: Effect[]; label: string };

/** A concrete mark on the sheet: `value` is what gets stored in the cell (1 for crosses, 1 = circled / 2 = crossed in two-state areas, the written — already multiplied — number for tracks). */
export interface Placement {
  area: string;
  cell: number;
  value: number;
}

/** Cell/group metadata used by UIs to render a sheet generically. */
export interface AreaUi {
  kind: 'grid' | 'track';
  columns: number;
  /** Cells hold 0 empty / 1 circled / 2 crossed instead of 0/1 (Twice yellow). */
  twoState?: boolean;
  /** pointsScale applies to each row group independently (Twice silver). */
  scalePerRow?: boolean;
  cells: {
    label: string | null; // '3', '≥4', '×2' ... null = free write slot
    pre?: boolean; // pre-printed cross
    void?: boolean; // layout hole (blue grid top-left, Twice yellow lattice)
    bonus?: Effect; // bonus under this cell
    asc?: boolean; // purple '<' separator before this cell
    desc?: boolean; // descend-track '≥' separator before this cell (Twice blue)
    pair?: number; // 0-based subtraction-pair index (Twice green)
  }[];
  /** Row/column/diagonal groups with completion bonuses or points (yellow, blue). */
  groups?: { cells: number[]; kind: 'row' | 'col' | 'diag'; bonus?: Effect; points?: number }[];
  /** Cumulative points scale to display (blue, green). */
  pointsScale?: number[];
}

/**
 * An area of the score sheet. Implementations are pure: cell state lives in
 * GameState.areas[id] as a plain number[] owned by the engine.
 */
export interface AreaDef {
  id: string;
  label: string;
  /** Die colors (besides the wild die) that may be placed here. */
  colors: DieColor[];
  size: number;
  init(): number[];
  /** Value a die of color `die` contributes to this area given all faces. */
  effectiveValue(faces: Faces, die: DieColor): number;
  /** Legal placements for a die contributing `value`. */
  placements(cells: number[], value: number): Placement[];
  /** Mutates `cells`, returns triggered effects (cell bonuses, completed groups). */
  apply(cells: number[], p: Placement): Effect[];
  score(cells: number[]): number;
  /** Open cells for a crossAny bonus ([] when unsupported). */
  openCells(cells: number[]): number[];
  /** Placement for a crossNext/writeNext bonus, or null when impossible. */
  bonusPlacement(cells: number[], kind: 'cross' | 'write', value?: number): Placement | null;
  /** Placements a free-mark bonus ({ t: 'free' }, colored ?) may choose ([] when full). */
  freePlacements(cells: number[]): Placement[];
  ui: AreaUi;
}

/** The unlockable action kinds — the keys of the sheet's action bars. */
export type BarKind = 'reroll' | 'plus1' | 'return';

/** One action bar: unlock-slot count and the bonus granted when the last slot is circled. */
export interface BarDef {
  size: number;
  endBonus: Effect | null;
}

/** A game variant = dice + sheet + round structure. */
export interface VariantDef {
  id: string;
  name: string;
  /** Die order; the index in this array is the die id used everywhere. */
  colors: DieColor[];
  wild: DieColor | null;
  rounds: number;
  picksPerTurn: number;
  /** Effect granted at the start of round i (index i-1), or null. */
  roundBonuses: (Effect | null)[];
  /** Action bars by kind; size 0 = the sheet has no such bar. */
  bars: Record<BarKind, BarDef>;
  /** When the per-die +1 usage flags reset: every turn (base) or every round (Twice). */
  plus1Scope: 'turn' | 'round';
  areas: AreaDef[];
  rating: { min: number; label: string }[];
}

export type Phase =
  | 'roll' // chance: roll the active player's remaining pool
  | 'preRoll' // decision: return-action window before an active roll (return platter dice / proceed)
  | 'pick' // decision: pick a die (or reroll / forfeit the roll)
  | 'endTurn' // decision: spend +1 actions, then end the active turn
  | 'passiveRoll' // chance: roll all six, three lowest to the platter
  | 'passivePick' // decision: take one platter die (or decline)
  | 'passiveEndTurn' // decision: spend +1 actions, then end the round
  | 'over';

export interface GameStats {
  rerollsUsed: number;
  plus1Spent: number;
  returnsUsed: number;
  skips: number;
  bonusesLost: number;
}

export interface GameState {
  variant: string;
  round: number; // 1-based
  phase: Phase;
  faces: number[]; // by die id (variant.colors order); 0 = never rolled
  loc: Loc[];
  picks: number; // active picks consumed this turn (0..picksPerTurn)
  rerolls: number; // unlocked, unspent reroll actions
  plus1: number; // unlocked, unspent +1 actions
  returns: number; // unlocked, unspent return actions
  plus1Used: boolean[]; // dice already taken via +1 this turn (or round — variant.plus1Scope)
  /** Cumulative unlocks per bar; capped at bars[kind].size, the cap fires the bar's endBonus. */
  barUnlocks: Record<BarKind, number>;
  pending: Effect[]; // queued bonus decisions (head is resolved first)
  areas: Record<string, number[]>;
  foxes: number;
  stats: GameStats;
}

export type Action =
  /** Resolve the head of the pending-bonus queue: `cell` for crossAny, `option` for choice. */
  | { t: 'bonus'; cell?: number; option?: number }
  | { t: 'reroll' }
  /** Return a platter die to the pool (preRoll); it joins the next roll. */
  | { t: 'return'; die: number }
  /** Leave the preRoll window and roll. */
  | { t: 'proceed' }
  /** Pick a die; no placement = "wasted pick" (only offered for dice with no legal placement). */
  | { t: 'pick'; die: number; placement?: Placement }
  /** Forfeit the roll: no die usable — consumes a pick, keeps the dice. */
  | { t: 'skip' }
  | { t: 'plus1'; die: number; placement: Placement }
  | { t: 'endTurn' }
  | { t: 'passivePick'; die: number; placement: Placement }
  | { t: 'passiveSkip' };

export type PendingNode =
  | { kind: 'over' }
  | { kind: 'chance' }
  | { kind: 'decision'; actions: Action[] };
