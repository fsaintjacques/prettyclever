import { useEffect, useMemo, useRef, useState } from 'react';
import {
  applyAction,
  areaById,
  facesByColor,
  getPending,
  mulberry32,
  type Action,
  type AreaDef,
  type Effect,
  type GameState,
  type VariantDef,
} from '../../engine';
import { makeStrategy, strategiesFor } from '../../strategies';
import { describeAction } from '../describe';

const DARK_INK = new Set(['white', 'yellow', 'silver']);

function MiniDie({ color, face }: { color: string; face: number }) {
  return (
    <span
      className={`mini-die die-${color} ${DARK_INK.has(color) ? 'ink-dark' : 'ink-light'}`}
      title={`${color} ${face}`}
    >
      {face > 0 ? face : ''}
    </span>
  );
}

function MiniArea({ area }: { area: string }) {
  return <span className={`mini-area die-${area}`} title={`${area} area`} />;
}

/** ui-cell index of engine cell `cell` (inverse of describe's uiToEngine). */
function uiIndexOf(area: AreaDef, cell: number): number {
  const cells = area.ui.cells;
  if (cells.length === area.size) return cell;
  let n = -1;
  for (let i = 0; i < cells.length; i++) {
    if (!cells[i].void && ++n === cell) return i;
  }
  return -1;
}

/**
 * "col 3" for the chosen cell when another currently-available option carries
 * the same printed label in the same grid area (base yellow: every value
 * appears twice) — the column pins down which one. Silver names its row via
 * describeAction already; track slots are positional and never ambiguous.
 */
function columnHint(
  variant: VariantDef,
  areaId: string,
  cell: number,
  optionCells: number[],
): string | null {
  const area = areaById(variant, areaId);
  if (area.ui.kind !== 'grid' || area.silverRows) return null;
  const ui = uiIndexOf(area, cell);
  if (ui < 0) return null;
  const label = area.ui.cells[ui]?.label;
  const ambiguous = optionCells.some(
    (c) => c !== cell && area.ui.cells[uiIndexOf(area, c)]?.label === label,
  );
  return ambiguous ? `col ${(ui % area.ui.columns) + 1}` : null;
}

/** The chosen bonus action's target area/cell plus its sibling options. */
function bonusTarget(
  state: GameState,
  actions: Action[],
  a: Action,
): { area: string; cell: number; options: number[] } | null {
  if (a.t !== 'bonus') return null;
  const head = state.pending[0];
  if (head?.t === 'crossAny' && a.cell !== undefined) {
    const options = actions.flatMap((x) => (x.t === 'bonus' && x.cell !== undefined ? [x.cell] : []));
    return { area: head.area, cell: a.cell, options };
  }
  if (a.placement) {
    const area = a.placement.area;
    const options = actions.flatMap((x) =>
      x.t === 'bonus' && x.placement?.area === area ? [x.placement.cell] : [],
    );
    return { area, cell: a.placement.cell, options };
  }
  return null;
}

/** One resolved bonus step: a mini sheet cell, or a plain glyph (↻, 🦊…). */
type Entry =
  | { kind: 'cell'; area: string; label: string; col?: string }
  | { kind: 'glyph'; text: string };

/** The printed label of a grid cell ("11", "6"…), if the area is a grid. */
function gridLabel(variant: VariantDef, areaId: string, cell: number): string | null {
  const area = areaById(variant, areaId);
  if (area.ui.kind !== 'grid') return null;
  const ui = uiIndexOf(area, cell);
  return ui >= 0 ? (area.ui.cells[ui]?.label ?? null) : null;
}

/** Immediate effects render directly; crossAny/free wait for their follow-up. */
function entryForEffect(e: Effect): Entry | null {
  switch (e.t) {
    case 'crossNext':
      return { kind: 'cell', area: e.area, label: 'X' };
    case 'writeNext':
      return { kind: 'cell', area: e.area, label: String(e.value) };
    case 'reroll':
      return { kind: 'glyph', text: '↻' };
    case 'plus1':
      return { kind: 'glyph', text: '+1' };
    case 'return':
      return { kind: 'glyph', text: '↩' };
    case 'fox':
      return { kind: 'glyph', text: '🦊' };
    default:
      return null; // crossAny/free/choice: the follow-up decision names the cell
  }
}

/** The visual entry for a resolved bonus action, or null if it has none. */
function entryForBonus(
  state: GameState,
  actions: Action[],
  a: Action,
  variant: VariantDef,
): Entry | null {
  if (a.t !== 'bonus') return null;
  const head = state.pending[0];
  if (head?.t === 'crossAny' && a.cell !== undefined) {
    const target = bonusTarget(state, actions, a);
    const col = target && columnHint(variant, target.area, target.cell, target.options);
    return {
      kind: 'cell',
      area: head.area,
      label: gridLabel(variant, head.area, a.cell) ?? 'X',
      col: col ?? undefined,
    };
  }
  if ((head?.t === 'free' || head?.t === 'silverMark') && a.placement) {
    const area = areaById(variant, a.placement.area);
    // Silver rows are color-coded — the row color says more than "silver".
    const colorId = area.silverRows
      ? area.silverRows[Math.floor(uiIndexOf(area, a.placement.cell) / area.ui.columns)]
      : a.placement.area;
    const label =
      area.ui.kind === 'grid' && !area.silverRows
        ? (gridLabel(variant, a.placement.area, a.placement.cell) ?? String(a.placement.value))
        : String(a.placement.value);
    const target = bonusTarget(state, actions, a);
    const col = target && columnHint(variant, target.area, target.cell, target.options);
    return { kind: 'cell', area: colorId, label, col: col ?? undefined };
  }
  if (head?.t === 'choice' && a.option !== undefined) {
    return entryForEffect(head.options[a.option]);
  }
  return null;
}

/** A strategy's decision plus the resolved bonus cells it would chain. */
interface Pick {
  a: Action;
  entries: Entry[];
}

/**
 * A strategy's chosen action, in dice-first shorthand:
 *   - the die chip alone when it lands in its own area,
 *   - blue plays blue+wild, so both operands show, the taken die first:
 *     "[blue] + [white] = total" or "[white] + [blue] = total",
 *   - "white → ▪" when the wild is spent on a color section,
 * and describeAction's text for everything that isn't a die pick.
 */
function MiniCell({ entry }: { entry: Entry & { kind: 'cell' } }) {
  return (
    <span
      className={`mini-cell die-${entry.area} ${DARK_INK.has(entry.area) ? 'ink-dark' : 'ink-light'}`}
      title={`${entry.area} ${entry.label}${entry.col ? ` (${entry.col})` : ''}`}
    >
      {entry.label}
    </span>
  );
}

function ChoiceLabel({
  state,
  variant,
  action,
  actions,
  entries,
}: {
  state: GameState;
  variant: VariantDef;
  action: Action;
  /** The full decision's action list — used to spot ambiguous targets. */
  actions: Action[];
  /** Resolved bonus steps the strategy would chain after this action. */
  entries: Entry[];
}) {
  const a = action;
  if (a.t === 'pick' || a.t === 'plus1' || a.t === 'passivePick') {
    const color = variant.colors[a.die];
    const prefix = a.t === 'plus1' ? <span className="hint">+1</span> : null;
    if (!a.placement) {
      return (
        <span className="choice">
          <MiniDie color={color} face={state.faces[a.die]} />
          <span className="hint">(no mark)</span>
        </span>
      );
    }
    const p = a.placement;
    const siblingCells = actions.flatMap((x) =>
      (x.t === 'pick' || x.t === 'plus1' || x.t === 'passivePick') &&
      x.die === a.die &&
      x.placement?.area === p.area
        ? [x.placement.cell]
        : [],
    );
    const loc = columnHint(variant, p.area, p.cell, siblingCells);
    const locHint = loc && <span className="hint">{loc}</span>;
    const blueDie = variant.colors.indexOf('blue');
    const wildDie = variant.wild ? variant.colors.indexOf(variant.wild) : -1;
    if (p.area === 'blue' && blueDie >= 0 && wildDie >= 0 && (a.die === blueDie || a.die === wildDie)) {
      // Blue always plays blue+wild; the placement value is just a mark, so the
      // combined total comes from the area's effectiveValue. The die that leads
      // is the one actually taken — it leaves the pool and sends every lower
      // die to the platter, which is the whole difference between the two.
      const total = areaById(variant, 'blue').effectiveValue(facesByColor(state, variant), color);
      const partner = a.die === blueDie ? wildDie : blueDie;
      return (
        <span className="choice">
          {prefix}
          <MiniDie color={color} face={state.faces[a.die]} />
          <span className="hint">+</span>
          <MiniDie color={variant.colors[partner]} face={state.faces[partner]} />
          <span>= {total}</span>
        </span>
      );
    }
    return (
      <span className="choice">
        {prefix}
        <MiniDie color={color} face={state.faces[a.die]} />
        {color !== p.area && (
          <>
            <span className="hint">→</span>
            <MiniArea area={p.area} />
          </>
        )}
        {locHint}
      </span>
    );
  }
  if (a.t === 'bonus' && entries.length > 0) {
    return (
      <span className="choice">
        <span className="hint">bonus:</span>
        {entries.map((e, i) => (
          <span key={i} className="choice">
            {i > 0 && <span className="hint">→</span>}
            {e.kind === 'cell' ? (
              <>
                <MiniCell entry={e} />
                {e.col && <span className="hint">{e.col}</span>}
              </>
            ) : (
              <span>{e.text}</span>
            )}
          </span>
        ))}
      </span>
    );
  }
  return <span className="hint">{describeAction(state, variant, a)}</span>;
}

// ---------------------------------------------------------------------------
// Per-variant display preferences (order + enabled), persisted to localStorage
// ---------------------------------------------------------------------------

interface Prefs {
  order: string[];
  disabled: string[];
  /** Blur the picks until the card is hovered — play without spoilers. */
  revealOnHover: boolean;
}

const prefsKey = (variantId: string) => `cleverlab.strategy-picks.v1:${variantId}`;

/**
 * Stored prefs merged with the live registry: forget strategies that no
 * longer exist, append newly registered ones (enabled) at the end.
 */
function loadPrefs(variantId: string, names: string[]): Prefs {
  let stored: Partial<Prefs> = {};
  try {
    stored = JSON.parse(localStorage.getItem(prefsKey(variantId)) ?? '{}');
  } catch {
    // corrupted entry — fall back to defaults
  }
  const known = new Set(names);
  const order = (Array.isArray(stored.order) ? stored.order : []).filter((n) => known.has(n));
  for (const n of names) if (!order.includes(n)) order.push(n);
  const disabled = (Array.isArray(stored.disabled) ? stored.disabled : []).filter((n) =>
    known.has(n),
  );
  return { order, disabled, revealOnHover: stored.revealOnHover === true };
}

function savePrefs(variantId: string, prefs: Prefs): void {
  try {
    localStorage.setItem(prefsKey(variantId), JSON.stringify(prefs));
  } catch {
    // storage full/unavailable — prefs just won't stick
  }
}

/** The gear popup: checkbox to show/hide, drag rows by the handle to reorder. */
function StrategyPicker({
  prefs,
  onChange,
}: {
  prefs: Prefs;
  onChange: (p: Prefs) => void;
}) {
  const dragFrom = useRef<number | null>(null);
  const disabled = new Set(prefs.disabled);

  const toggle = (name: string) => {
    onChange({
      ...prefs,
      disabled: disabled.has(name)
        ? prefs.disabled.filter((n) => n !== name)
        : [...prefs.disabled, name],
    });
  };

  const drop = (to: number) => {
    const from = dragFrom.current;
    dragFrom.current = null;
    if (from === null || from === to) return;
    const order = prefs.order.slice();
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);
    onChange({ ...prefs, order });
  };

  return (
    <div className="picker-pop" role="dialog" aria-label="choose and order strategies">
      {prefs.order.map((name, i) => (
        <div
          key={name}
          className="picker-row"
          draggable
          onDragStart={() => (dragFrom.current = i)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => drop(i)}
        >
          <span className="drag-handle" title="drag to reorder">
            ⠿
          </span>
          <label>
            <input type="checkbox" checked={!disabled.has(name)} onChange={() => toggle(name)} />
            {name}
          </label>
        </div>
      ))}
      <div className="picker-row picker-option">
        <label>
          <input
            type="checkbox"
            checked={prefs.revealOnHover}
            onChange={() => onChange({ ...prefs, revealOnHover: !prefs.revealOnHover })}
          />
          Show picks on hover only
        </label>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

/**
 * Right-rail card: what every registered strategy would do at the current
 * decision. Choices are computed one strategy per timeout tick so the heavy
 * searchers (mcts, mc) don't freeze the UI in one long block; already-shown
 * picks are kept when a strategy is toggled on, so only the newcomer runs.
 */
export function StrategyPicks({
  state,
  variant,
  actions,
}: {
  state: GameState;
  variant: VariantDef;
  actions: Action[];
}) {
  const registry = useMemo(() => {
    const byName = new Map<string, ReturnType<typeof makeStrategy>>();
    for (const name of Object.keys(strategiesFor(variant.id))) {
      byName.set(name, makeStrategy(variant.id, name));
    }
    return byName;
  }, [variant.id]);

  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs(variant.id, [...registry.keys()]));
  const updatePrefs = (p: Prefs) => {
    setPrefs(p);
    savePrefs(variant.id, p);
  };
  const shown = useMemo(
    () => prefs.order.filter((n) => !prefs.disabled.includes(n)),
    [prefs],
  );

  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const [picks, setPicks] = useState<Record<string, Pick | null>>({});
  const picksRef = useRef(picks);
  const lastState = useRef<GameState | null>(null);

  useEffect(() => {
    if (lastState.current !== state) {
      // New position — every strategy has to re-decide.
      lastState.current = state;
      picksRef.current = {};
      setPicks({});
    }
    if (actions.length === 0) return;
    let cancelled = false;
    const step = () => {
      if (cancelled) return;
      const name = shown.find((n) => !(n in picksRef.current));
      const strat = name !== undefined ? registry.get(name) : undefined;
      if (name === undefined || !strat) return;
      let pick: Pick | null = null;
      try {
        const ctx = { variant, rng: mulberry32(0xfeed) };
        const choice = strat.choose(state, actions, ctx);
        // A bonus choice (e.g. a round bonus "X in blue") only enqueues the
        // effect — the concrete cell is a follow-up decision. Resolve those
        // forward with the same strategy so the row can show which cell.
        const entries: Entry[] = [];
        if (choice.t === 'bonus') {
          const first = entryForBonus(state, actions, choice, variant);
          if (first) entries.push(first);
          try {
            let s2 = applyAction(state, variant, choice);
            let guard = 0;
            while (s2.pending.length > 0 && guard++ < 6) {
              const n2 = getPending(s2, variant);
              if (n2.kind !== 'decision') break;
              const a2 = strat.choose(s2, n2.actions, ctx);
              const e = entryForBonus(s2, n2.actions, a2, variant);
              if (e) entries.push(e);
              s2 = applyAction(s2, variant, a2);
            }
          } catch {
            // lookahead is best-effort; show what resolved so far
          }
        }
        pick = { a: choice, entries };
      } catch {
        // a strategy that chokes on a node just shows "—"
      }
      picksRef.current = { ...picksRef.current, [name]: pick };
      setPicks(picksRef.current);
      window.setTimeout(step, 0);
    };
    const t = window.setTimeout(step, 60); // debounce rapid state changes
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [state, actions, shown, registry, variant]);

  return (
    <div className={`panel strategy-picks${prefs.revealOnHover ? ' conceal' : ''}`}>
      <div className="panel-head">
        <h3>Strategy picks</h3>
        <div ref={popRef} className="picker-anchor">
          <button
            className="gear-btn"
            title="choose and order strategies"
            aria-label="choose and order strategies"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            ⚙
          </button>
          {open && <StrategyPicker prefs={prefs} onChange={updatePrefs} />}
        </div>
      </div>
      {actions.length === 0 ? (
        <span className="hint">Waiting for a decision…</span>
      ) : shown.length === 0 ? (
        <span className="hint">All strategies hidden — pick some via ⚙.</span>
      ) : (
        <div className="picks-box">
          <div className="picks">
            {shown.map((name) => (
              <div key={name} className="pick-row">
                <span className="strat-name">{name}</span>
                {!(name in picks) ? (
                  <span className="hint">…</span>
                ) : picks[name] ? (
                  <ChoiceLabel
                    state={state}
                    variant={variant}
                    action={picks[name].a}
                    actions={actions}
                    entries={picks[name].entries}
                  />
                ) : (
                  <span className="hint">—</span>
                )}
              </div>
            ))}
          </div>
          {prefs.revealOnHover && <span className="reveal-hint">hover to reveal</span>}
        </div>
      )}
    </div>
  );
}
