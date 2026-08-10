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

// ---------------------------------------------------------------------------
// Persistence: the session (state + RNG position + log + undo tail) survives a
// browser refresh via localStorage, keyed per view so play/watch/variant each
// keep their own game.
// ---------------------------------------------------------------------------

/** Undo history entries persisted across a refresh (in-memory keeps 200). */
const SAVED_HISTORY = 50;

interface SavedSession {
  v: 1;
  variant: string;
  seed: number;
  /** mulberry32 internal state, so future rolls continue the same stream. */
  rng: number;
  state: GameState;
  log: LogEntry[];
  history: GameState[];
}

const sessionKey = (storageKey: string) => `cleverlab.session.v1:${storageKey}`;

function loadSession(storageKey: string, variantId: string): SavedSession | null {
  try {
    const raw = localStorage.getItem(sessionKey(storageKey));
    if (!raw) return null;
    const s = JSON.parse(raw) as SavedSession;
    if (s.v !== 1 || s.variant !== variantId) return null;
    if (typeof s.seed !== 'number' || typeof s.rng !== 'number') return null;
    if (!s.state || s.state.variant !== variantId || !Array.isArray(s.state.loc)) return null;
    return {
      ...s,
      log: Array.isArray(s.log) ? s.log : [],
      history: Array.isArray(s.history) ? s.history : [],
    };
  } catch {
    return null; // corrupted or unavailable storage — start fresh
  }
}

function saveSession(storageKey: string, s: SavedSession): void {
  try {
    localStorage.setItem(sessionKey(storageKey), JSON.stringify(s));
  } catch {
    // storage full/unavailable — the game just won't survive a refresh
  }
}

/**
 * Owns a game state + RNG + history. Chance nodes resolve automatically
 * (when `autoChance` is true) so consumers only ever see decision nodes.
 * When `storageKey` is given the session persists across browser refreshes.
 */
export function useGame(variant: VariantDef, autoChance = true, storageKey?: string): GameSession {
  // Restore once per mount; the App keys GameView by mode+variant, so a
  // variant/mode switch remounts and re-reads its own saved session.
  const restored = useMemo(
    () => (storageKey ? loadSession(storageKey, variant.id) : null),
    [storageKey, variant.id],
  );
  const [seed, setSeed] = useState(() => restored?.seed ?? Math.floor(Math.random() * 1e9));
  const rngRef = useRef(mulberry32(seed));
  const restoredRng = useRef(false);
  if (!restoredRng.current) {
    restoredRng.current = true;
    if (restored) rngRef.current.setState(restored.rng);
  }
  const [state, setState] = useState(() => restored?.state ?? newGame(variant));
  const [history, setHistory] = useState<GameState[]>(() => restored?.history ?? []);
  const [log, setLog] = useState<LogEntry[]>(() => restored?.log ?? []);

  const node = useMemo(() => getPending(state, variant), [state, variant]);

  // Save BEFORE the auto-chance effect below: rolling advances the RNG in the
  // same effect pass, and the snapshot must pair the committed state with the
  // RNG position that produces its next roll.
  useEffect(() => {
    if (!storageKey) return;
    saveSession(storageKey, {
      v: 1,
      variant: variant.id,
      seed,
      rng: rngRef.current.getState(),
      state,
      log,
      history: history.slice(-SAVED_HISTORY),
    });
  }, [storageKey, variant.id, seed, state, log, history]);

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
