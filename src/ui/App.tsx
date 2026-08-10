import { useEffect, useMemo, useRef, useState } from 'react';
import {
  getPending,
  mulberry32,
  scoreState,
  variants,
  type Action,
  type GameState,
  type Placement,
  type VariantDef,
} from '../engine';
import { makeStrategy, strategiesFor } from '../strategies';
import { describeEffect } from './describe';
import { useGame } from './useGame';
import { DiceTray } from './components/Dice';
import { ScorePanel } from './components/ScorePanel';
import { Sheet } from './components/Sheet';
import { SimPanel } from './components/SimPanel';

type Mode = 'play' | 'watch' | 'sim';

function phaseLabel(s: GameState, v: VariantDef): string {
  switch (s.phase) {
    case 'roll':
    case 'preRoll':
    case 'pick':
      return `Active turn — pick ${Math.min(s.picks + 1, v.picksPerTurn)} of ${v.picksPerTurn}`;
    case 'endTurn':
      return 'Active turn — spend +1 actions or end the turn';
    case 'passiveRoll':
    case 'passivePick':
      return 'Passive turn — take one die from the platter';
    case 'passiveEndTurn':
      return 'Passive turn — spend +1 actions or end the round';
    case 'over':
      return 'Game over';
  }
}

/** Seed input + New game: empty seed = random, a number = reproducible game. */
function NewGame({ reset }: { reset: (seed?: number) => void }) {
  const [seed, setSeed] = useState('');
  const start = () => {
    const n = Number(seed.trim());
    reset(seed.trim() !== '' && Number.isFinite(n) ? n >>> 0 : undefined);
  };
  return (
    <>
      <input
        type="text"
        inputMode="numeric"
        placeholder="seed (random)"
        value={seed}
        onChange={(e) => setSeed(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && start()}
        style={{ width: 110 }}
        aria-label="seed for the next game"
      />
      <button className="btn subtle" onClick={start}>
        New game
      </button>
    </>
  );
}

function GameView({ mode, variant }: { mode: 'play' | 'watch'; variant: VariantDef }) {
  const session = useGame(variant, true, `${mode}:${variant.id}`);
  const { state } = session;
  const node = useMemo(() => getPending(state, variant), [state, variant]);
  const score = useMemo(() => scoreState(state, variant), [state, variant]);
  const actions = node.kind === 'decision' ? node.actions : [];
  const interactive = mode === 'play';

  const [selectedDie, setSelectedDie] = useState<number | null>(null);
  useEffect(() => setSelectedDie(null), [state]);

  // --- watch-mode bot -----------------------------------------------------
  const [strategyName, setStrategyName] = useState('greedy');
  const strategy = useMemo(() => makeStrategy(variant.id, strategyName), [variant.id, strategyName]);
  const botRng = useRef(mulberry32(0xbeef));
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(400);

  useEffect(() => {
    if (mode !== 'watch' || !running) return;
    if (node.kind === 'over') {
      setRunning(false);
      return;
    }
    if (node.kind !== 'decision') return; // chance auto-resolves
    const t = setTimeout(() => {
      session.act(strategy.choose(state, node.actions, { variant, rng: botRng.current }));
    }, speed);
    return () => clearTimeout(t);
  }, [mode, running, node, speed, strategy, session, state, variant]);

  useEffect(() => setRunning(false), [mode]);

  // --- interactive wiring -------------------------------------------------
  const head = state.pending[0];

  // Return window: clicking a platter die returns it to the pool.
  const returnByDie = useMemo(() => {
    const map = new Map<number, Action>();
    if (!interactive) return map;
    for (const a of actions) if (a.t === 'return') map.set(a.die, a);
    return map;
  }, [actions, interactive]);

  const selectableDice = useMemo(() => {
    const set = new Set<number>();
    if (!interactive) return set;
    for (const a of actions) {
      if (a.t === 'pick' || a.t === 'plus1' || a.t === 'passivePick' || a.t === 'return') {
        set.add(a.die);
      }
    }
    return set;
  }, [actions, interactive]);

  // Placement-carrying bonus decisions (free ? marks, white/silver chain marks).
  const placementBonuses = useMemo(
    () =>
      head?.t === 'free' || head?.t === 'silverMark'
        ? actions.filter(
            (a): a is Extract<Action, { t: 'bonus' }> & { placement: Placement } =>
              a.t === 'bonus' && a.placement !== undefined,
          )
        : [],
    [actions, head],
  );
  // When every option targets its own cell (silver ?, yellow ?, chain-mark row
  // choice) the sheet cells glow like crossAny; a track's free write keeps the
  // choice in the action banner instead (one cell, many values).
  const bonusCellsUnique = useMemo(
    () =>
      new Set(placementBonuses.map((a) => `${a.placement.area}:${a.placement.cell}`)).size ===
      placementBonuses.length,
    [placementBonuses],
  );

  const activeCells = useMemo(() => {
    const map = new Map<string, Action>();
    if (!interactive) return map;
    for (const a of actions) {
      if (a.t === 'bonus' && a.cell !== undefined && head?.t === 'crossAny') {
        map.set(`${head.area}:${a.cell}`, a);
      }
      if (
        a.t === 'bonus' &&
        a.placement &&
        bonusCellsUnique &&
        (head?.t === 'free' || head?.t === 'silverMark')
      ) {
        map.set(`${a.placement.area}:${a.placement.cell}`, a);
      }
      if ((a.t === 'pick' || a.t === 'plus1' || a.t === 'passivePick') && a.die === selectedDie) {
        const p = a.t === 'pick' ? a.placement : a.placement;
        if (p) map.set(`${p.area}:${p.cell}`, a);
      }
    }
    return map;
  }, [actions, selectedDie, head, interactive, bonusCellsUnique]);

  const find = (pred: (a: Action) => boolean) => actions.find(pred);
  const rerollAction = find((a) => a.t === 'reroll');
  const skipAction = find((a) => a.t === 'skip');
  const endTurnAction = find((a) => a.t === 'endTurn');
  const passiveSkipAction = find((a) => a.t === 'passiveSkip');
  const proceedAction = find((a) => a.t === 'proceed');
  const wastedPick =
    selectedDie !== null
      ? find((a) => a.t === 'pick' && a.die === selectedDie && !a.placement)
      : undefined;
  const choiceOptions =
    head?.t === 'choice'
      ? actions.filter((a): a is Action & { t: 'bonus'; option: number } => a.t === 'bonus')
      : [];

  const hint =
    node.kind === 'over'
      ? ''
      : head?.t === 'crossAny'
        ? `Bonus: cross any glowing ${head.area} cell.`
        : head?.t === 'silverMark'
          ? `Platter chain: choose a silver row for the ${head.value}.`
          : head?.t === 'free'
            ? bonusCellsUnique
              ? `Bonus: mark any glowing ${head.area} cell.`
              : `Bonus: choose a value to write in ${head.area}.`
            : head?.t === 'choice'
              ? head.label
              : state.phase === 'preRoll'
                ? 'Return window: click a platter die to take it back, or roll on.'
                : selectedDie !== null && activeCells.size === 0
                  ? 'No legal placement for this die.'
                  : selectedDie !== null
                    ? 'Now click a glowing cell.'
                    : selectableDice.size > 0
                      ? 'Click a die to see where it can go.'
                      : '';

  return (
    <div className="main">
      <div>
        <DiceTray
          state={state}
          variant={variant}
          selectable={selectableDice}
          selected={selectedDie}
          onDieClick={(i) => {
            const ret = returnByDie.get(i);
            if (ret) session.act(ret);
            else setSelectedDie((d) => (d === i ? null : i));
          }}
        />

        {node.kind === 'over' ? (
          <div className="banner" style={{ marginBottom: 12 }}>
            <span>
              Final score {score.total} — {phaseLabel(state, variant)}
            </span>
            <button className="btn primary" onClick={() => session.reset()}>
              New game
            </button>
          </div>
        ) : head?.t === 'choice' && interactive ? (
          <div className="banner" style={{ marginBottom: 12 }}>
            <span>{head.label}:</span>
            {choiceOptions.map((a) => (
              <button key={a.option} className="btn" onClick={() => session.act(a)}>
                {describeEffect(head.options[a.option])}
              </button>
            ))}
          </div>
        ) : (
          head?.t === 'free' &&
          !bonusCellsUnique &&
          interactive && (
            <div className="banner" style={{ marginBottom: 12 }}>
              <span>Bonus — {describeEffect(head)}:</span>
              {placementBonuses.map((a, i) => (
                <button key={i} className="btn" onClick={() => session.act(a)}>
                  write {a.placement.value}
                </button>
              ))}
            </div>
          )
        )}

        <div className="hint status-line">
          <strong>Round {state.round}/{variant.rounds}</strong> · {phaseLabel(state, variant)}
          {hint && <> — {hint}</>}
        </div>
        <div className="controls" style={{ marginBottom: 12 }}>
          {mode === 'play' && (
            <>
              {rerollAction && (
                <button className="btn" onClick={() => session.act(rerollAction)}>
                  Re-roll ({state.rerolls})
                </button>
              )}
              {wastedPick && (
                <button className="btn" onClick={() => session.act(wastedPick)}>
                  Take die (no mark)
                </button>
              )}
              {skipAction && (
                <button className="btn" onClick={() => session.act(skipAction)}>
                  Forfeit roll
                </button>
              )}
              {passiveSkipAction && (
                <button className="btn" onClick={() => session.act(passiveSkipAction)}>
                  Decline
                </button>
              )}
              {proceedAction && (
                <button className="btn primary" onClick={() => session.act(proceedAction)}>
                  Roll on ({state.returns} return{state.returns === 1 ? '' : 's'} left)
                </button>
              )}
              {endTurnAction && (
                <button className="btn primary" onClick={() => session.act(endTurnAction)}>
                  {state.phase === 'endTurn' ? 'End turn' : 'End round'}
                </button>
              )}
              <button className="btn subtle" onClick={session.undo} disabled={!session.canUndo}>
                Undo
              </button>
              <NewGame reset={session.reset} />
            </>
          )}

          {mode === 'watch' && (
            <>
              <select value={strategyName} onChange={(e) => setStrategyName(e.target.value)}>
                {Object.keys(strategiesFor(variant.id)).map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
              <label className="hint">
                speed
                <input
                  type="range"
                  min={30}
                  max={1000}
                  value={1030 - speed}
                  onChange={(e) => setSpeed(1030 - Number(e.target.value))}
                  style={{ verticalAlign: 'middle', marginLeft: 6 }}
                />
              </label>
              <button
                className="btn primary"
                onClick={() => setRunning((r) => !r)}
                disabled={node.kind === 'over'}
              >
                {running ? 'Pause' : 'Run'}
              </button>
              <button
                className="btn"
                disabled={running || node.kind !== 'decision'}
                onClick={() => {
                  if (node.kind === 'decision') {
                    session.act(strategy.choose(state, node.actions, { variant, rng: botRng.current }));
                  }
                }}
              >
                Step
              </button>
              <button
                className="btn"
                disabled={running || node.kind === 'over'}
                onClick={() => session.finish(strategy, botRng.current)}
              >
                Finish
              </button>
              <NewGame reset={session.reset} />
            </>
          )}
        </div>

        <Sheet
          state={state}
          variant={variant}
          scores={score.areas}
          active={new Set(activeCells.keys())}
          onCellClick={(area, cell) => {
            const a = activeCells.get(`${area}:${cell}`);
            if (a) session.act(a);
          }}
        />
      </div>

      <div className="rail">
        <ScorePanel variant={variant} score={score} final={node.kind === 'over'} />
        <div className="panel">
          <h3>Turn log</h3>
          <div className="log">
            {session.log.length === 0 && <span className="hint">Nothing yet — roll and pick.</span>}
            {session.log.slice(-120).map((e, i) => (
              <div key={i} className="entry">
                <span className="rnd">R{e.round}</span>
                <span>{e.text}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="panel hint">
          Seed {session.seed} · white is wild · blue scores blue+white ·{' '}
          {mode === 'play' ? 'Undo is allowed, it’s a lab.' : `Bot: ${strategy.name}`}
        </div>
      </div>
    </div>
  );
}

export function App() {
  const [mode, setMode] = useState<Mode>('play');
  // Single source of truth for the selected variant; everything below receives it as a prop.
  const variantIds = Object.keys(variants);
  const [variantId, setVariantId] = useState(variantIds[0]);
  const variant = variants[variantId];
  return (
    <div className="app">
      <header className="topbar">
        <div className="wordmark">
          Clever Lab<span className="fox-dot">.</span>
          <small>{variant.name} — solo strategy workbench</small>
        </div>
        {variantIds.length > 1 && (
          <select
            value={variantId}
            onChange={(e) => setVariantId(e.target.value)}
            aria-label="game variant"
          >
            {variantIds.map((id) => (
              <option key={id} value={id}>
                {variants[id].name}
              </option>
            ))}
          </select>
        )}
        <nav className="tabs" role="tablist">
          {(['play', 'watch', 'sim'] as const).map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
            >
              {m === 'play' ? 'Play' : m === 'watch' ? 'Watch a bot' : 'Simulate'}
            </button>
          ))}
        </nav>
      </header>

      {mode === 'sim' ? (
        <SimPanel key={variant.id} variant={variant} />
      ) : (
        <GameView key={`${mode}:${variant.id}`} mode={mode} variant={variant} />
      )}

      <footer className="credits">
        Game design by Wolfgang Warsch, published by Schmidt Spiele. This is an unofficial
        fan-made lab for strategy experiments.
      </footer>
    </div>
  );
}
