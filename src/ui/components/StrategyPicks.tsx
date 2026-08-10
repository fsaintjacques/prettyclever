import { useEffect, useMemo, useRef, useState } from 'react';
import {
  areaById,
  facesByColor,
  mulberry32,
  type Action,
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

/**
 * A strategy's chosen action, in dice-first shorthand:
 *   - the die chip alone when it lands in its own area,
 *   - blue plays blue+white: "[blue] (total)", or "[blue] (+[white] = total)"
 *     when it's the wild being spent there,
 *   - "white → ▪" when the wild is spent on a color section,
 * and describeAction's text for everything that isn't a die pick.
 */
function ChoiceLabel({
  state,
  variant,
  action,
}: {
  state: GameState;
  variant: VariantDef;
  action: Action;
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
    if (p.area === 'blue' && (color === 'blue' || color === 'white')) {
      // Blue always plays blue+white; the cross-grid placement value is just
      // a mark, so the combined total comes from the area's effectiveValue.
      const total = areaById(variant, 'blue').effectiveValue(facesByColor(state, variant), color);
      if (color === 'blue') {
        return (
          <span className="choice">
            {prefix}
            <MiniDie color={color} face={state.faces[a.die]} />
            <span>({total})</span>
          </span>
        );
      }
      // The wild spent on blue: it's the blue slot that gets marked.
      const blue = variant.colors.indexOf('blue');
      return (
        <span className="choice">
          {prefix}
          <MiniDie color="blue" face={blue >= 0 ? state.faces[blue] : 0} />
          <span>(+</span>
          <MiniDie color={color} face={state.faces[a.die]} />
          <span>= {total})</span>
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
  return { order, disabled };
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

  const [picks, setPicks] = useState<Record<string, Action | null>>({});
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
      let choice: Action | null = null;
      try {
        choice = strat.choose(state, actions, { variant, rng: mulberry32(0xfeed) });
      } catch {
        // a strategy that chokes on a node just shows "—"
      }
      picksRef.current = { ...picksRef.current, [name]: choice };
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
    <div className="panel strategy-picks">
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
        <div className="picks">
          {shown.map((name) => (
            <div key={name} className="pick-row">
              <span className="strat-name">{name}</span>
              {!(name in picks) ? (
                <span className="hint">…</span>
              ) : picks[name] ? (
                <ChoiceLabel state={state} variant={variant} action={picks[name]} />
              ) : (
                <span className="hint">—</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
