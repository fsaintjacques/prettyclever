import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyAction,
  applyActionMut,
  cloneState,
  getPending,
  mulberry32,
  newGame,
  resolveChanceMut,
  type Action,
  type GameState,
  type RNG,
  type VariantDef,
} from '../engine';
import type { Strategy } from '../strategies';
import { describeAction } from './describe';

export interface LogEntry {
  round: number;
  text: string;
}

export interface GameSession {
  state: GameState;
  seed: number;
  log: LogEntry[];
  canUndo: boolean;
  act: (a: Action) => void;
  undo: () => void;
  reset: (seed?: number) => void;
  /** Let a strategy play the rest of the game synchronously. */
  finish: (strategy: Strategy, botRng: RNG) => void;
}

/**
 * Owns a game state + RNG + history. Chance nodes resolve automatically
 * (when `autoChance` is true) so consumers only ever see decision nodes.
 */
export function useGame(variant: VariantDef, autoChance = true): GameSession {
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1e9));
  const rngRef = useRef(mulberry32(seed));
  const [state, setState] = useState(() => newGame(variant));
  const [history, setHistory] = useState<GameState[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);

  const node = useMemo(() => getPending(state, variant), [state, variant]);

  useEffect(() => {
    if (!autoChance || node.kind !== 'chance') return;
    const s = cloneState(state);
    resolveChanceMut(s, variant, rngRef.current);
    setState(s);
  }, [node, state, variant, autoChance]);

  const act = useCallback(
    (a: Action) => {
      setHistory((h) => [...h.slice(-200), state]);
      setLog((l) => [...l, { round: state.round, text: describeAction(state, variant, a) }]);
      setState(applyAction(state, variant, a));
    },
    [state, variant],
  );

  const undo = useCallback(() => {
    setHistory((h) => {
      if (h.length === 0) return h;
      setState(h[h.length - 1]);
      setLog((l) => l.slice(0, -1));
      return h.slice(0, -1);
    });
  }, []);

  const reset = useCallback(
    (newSeed?: number) => {
      const sd = newSeed ?? Math.floor(Math.random() * 1e9);
      setSeed(sd);
      rngRef.current = mulberry32(sd);
      setState(newGame(variant));
      setHistory([]);
      setLog([]);
    },
    [variant],
  );

  const finish = useCallback(
    (strategy: Strategy, botRng: RNG) => {
      const s = cloneState(state);
      const entries: LogEntry[] = [];
      let guard = 0;
      while (guard++ < 10000) {
        const n = getPending(s, variant);
        if (n.kind === 'over') break;
        if (n.kind === 'chance') {
          resolveChanceMut(s, variant, rngRef.current);
          continue;
        }
        const a = strategy.choose(s, n.actions, { variant, rng: botRng });
        entries.push({ round: s.round, text: describeAction(s, variant, a) });
        applyActionMut(s, variant, a);
      }
      setHistory((h) => [...h.slice(-200), state]);
      setLog((l) => [...l, ...entries]);
      setState(s);
    },
    [state, variant],
  );

  return { state, seed, log, canUndo: history.length > 0, act, undo, reset, finish };
}
