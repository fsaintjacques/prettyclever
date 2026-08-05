/**
 * Core types for the Clever engine.
 *
 * The engine models a solo game as an explicit sequential decision process:
 * decision nodes (enumerable legal actions) alternate with chance nodes
 * (dice rolls, driven by an injectable RNG), which makes it directly usable
 * by search algorithms (greedy, Monte-Carlo, expectimax, RL, ...).
 */

export type DieColor = 'white' | 'yellow' | 'blue' | 'green' | 'orange' | 'purple';

/** Where a die currently sits during a turn. */
export type Loc = 'pool' | 'platter' | 'field';

/** Current face value per die color. */
export type Faces = Record<string, number>;

/**
 * An effect is anything a cell/row/column bonus can grant. Effects either
 * resolve automatically (fox, reroll, plus1, crossNext, writeNext) or require
 * a player decision (crossAny, choice) and are queued as pending decisions.
 */
export type Effect =
  | { t: 'fox' }
  | { t: 'reroll' }
  | { t: 'plus1' }
  /** Cross any open cell of the given area (yellow X / blue X bonuses). */
  | { t: 'crossAny'; area: string }
  /** Cross the next cell of an ordered area, ignoring entry requirements (green X). */
  | { t: 'crossNext'; area: string }
  /** Write a fixed number in the next slot of an ordered area (orange 4/5/6, purple 6). */
  | { t: 'writeNext'; area: string; value: number }
  /** Player chooses one of several effects (round-4 black X | black 6). */
  | { t: 'choice'; options: Effect[]; label: string };

/** A concrete mark on the sheet: `value` is what gets stored in the cell (1 for crosses, the written — already multiplied — number for tracks). */
export interface Placement {
  area: string;
  cell: number;
  value: number;
}

/** Cell/group metadata used by UIs to render a sheet generically. */
export interface AreaUi {
  kind: 'grid' | 'track';
  columns: number;
  cells: {
    label: string | null; // '3', '≥4', '×2' ... null = free write slot
    pre?: boolean; // pre-printed cross
    void?: boolean; // layout hole (blue grid top-left)
    bonus?: Effect; // bonus under this cell
    asc?: boolean; // purple '<' separator before this cell
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
  ui: AreaUi;
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
  areas: AreaDef[];
  rating: { min: number; label: string }[];
}

export type Phase =
  | 'roll' // chance: roll the active player's remaining pool
  | 'pick' // decision: pick a die (or reroll / forfeit the roll)
  | 'endTurn' // decision: spend +1 actions, then end the active turn
  | 'passiveRoll' // chance: roll all six, three lowest to the platter
  | 'passivePick' // decision: take one platter die (or decline)
  | 'passiveEndTurn' // decision: spend +1 actions, then end the round
  | 'over';

export interface GameStats {
  rerollsUsed: number;
  plus1Spent: number;
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
  plus1Used: boolean[]; // dice already taken via +1 this turn
  pending: Effect[]; // queued bonus decisions (head is resolved first)
  areas: Record<string, number[]>;
  foxes: number;
  stats: GameStats;
}

export type Action =
  /** Resolve the head of the pending-bonus queue: `cell` for crossAny, `option` for choice. */
  | { t: 'bonus'; cell?: number; option?: number }
  | { t: 'reroll' }
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
