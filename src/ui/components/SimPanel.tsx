import { useEffect, useRef, useState } from 'react';
import type { VariantDef } from '../../engine';
import { strategyRegistry } from '../../strategies';
import type { SimStats } from '../../sim/stats';
import type { SimRequest, SimResponse } from '../simWorker';
import { Histogram } from './Histogram';

interface Run {
  id: number;
  strategy: string;
  games: number;
  seed: number;
  stats?: SimStats;
  ms?: number;
  progress: number;
  error?: string;
}

/** Chart series order matches the validated palette adjacency, not the sheet. */
const CHART_ORDER: { id: string; label: string; color: string }[] = [
  { id: 'yellow', label: 'Yellow', color: 'var(--ch-yellow)' },
  { id: 'blue', label: 'Blue', color: 'var(--ch-blue)' },
  { id: 'green', label: 'Green', color: 'var(--ch-green)' },
  { id: 'purple', label: 'Purple', color: 'var(--ch-purple)' },
  { id: 'orange', label: 'Orange', color: 'var(--ch-orange)' },
];

export function SimPanel({ variant }: { variant: VariantDef }) {
  const [strategy, setStrategy] = useState('greedy');
  const [games, setGames] = useState(500);
  const [seed, setSeed] = useState(1);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const nextId = useRef(1);

  useEffect(() => {
    const w = new Worker(new URL('../simWorker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<SimResponse>) => {
      const msg = e.data;
      setRuns((rs) =>
        rs.map((r) => {
          if (r.id !== msg.id) return r;
          if (msg.type === 'progress') return { ...r, progress: msg.done };
          if (msg.type === 'error') return { ...r, error: msg.message };
          return { ...r, stats: msg.stats, ms: msg.ms, progress: r.games };
        }),
      );
      if (msg.type === 'done') setSelected(msg.id);
    };
    workerRef.current = w;
    return () => w.terminate();
  }, []);

  const running = runs.some((r) => !r.stats && !r.error);

  const start = () => {
    const id = nextId.current++;
    setRuns((rs) => [...rs, { id, strategy, games, seed, progress: 0 }]);
    const req: SimRequest = { id, variantId: variant.id, strategy, games, seed };
    workerRef.current?.postMessage(req);
  };

  const current = runs.find((r) => r.id === selected) ?? runs.findLast((r) => r.stats);
  const isMC = strategy.startsWith('mc');

  return (
    <div className="panel">
      <h3>Simulate</h3>
      <div className="sim-form">
        <label className="field">
          Strategy
          <select value={strategy} onChange={(e) => setStrategy(e.target.value)}>
            {Object.keys(strategyRegistry).map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
        <label className="field">
          Games
          <input
            type="number"
            min={1}
            max={100000}
            value={games}
            onChange={(e) => setGames(Number(e.target.value))}
            style={{ width: 90 }}
          />
        </label>
        <label className="field">
          Seed
          <input
            type="number"
            value={seed}
            onChange={(e) => setSeed(Number(e.target.value))}
            style={{ width: 90 }}
          />
        </label>
        <button className="btn primary" onClick={start} disabled={running}>
          {running ? 'Running…' : 'Run'}
        </button>
        {isMC && games > 200 && (
          <span className="hint">Monte-Carlo is ~100ms per game; this run will take a while.</span>
        )}
      </div>

      {runs.length > 0 && (
        <table className="runs-table">
          <thead>
            <tr>
              <th>Strategy</th>
              <th>Games</th>
              <th>Seed</th>
              <th>Mean</th>
              <th>Median</th>
              <th>P90</th>
              <th>Best</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr
                key={r.id}
                className={current?.id === r.id ? 'selected' : ''}
                onClick={() => setSelected(r.id)}
              >
                <td>{r.strategy}</td>
                <td>{r.games}</td>
                <td>{r.seed}</td>
                {r.error ? (
                  <td colSpan={5}>{r.error}</td>
                ) : r.stats ? (
                  <>
                    <td>
                      {r.stats.mean.toFixed(1)} ± {r.stats.std.toFixed(1)}
                    </td>
                    <td>{r.stats.p50}</td>
                    <td>{r.stats.p90}</td>
                    <td>{r.stats.max}</td>
                    <td>{((r.ms ?? 0) / 1000).toFixed(1)}s</td>
                  </>
                ) : (
                  <td colSpan={5}>
                    <div className="progress">
                      <div style={{ width: `${(100 * r.progress) / r.games}%` }} />
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {current?.stats && (
        <div>
          <div className="tiles">
            <div className="tile">
              <div className="t-label">Mean</div>
              <div className="t-value">{current.stats.mean.toFixed(1)}</div>
              <div className="t-sub">± {current.stats.std.toFixed(1)}</div>
            </div>
            <div className="tile">
              <div className="t-label">Median</div>
              <div className="t-value">{current.stats.p50}</div>
              <div className="t-sub">p10 {current.stats.p10}</div>
            </div>
            <div className="tile">
              <div className="t-label">P90</div>
              <div className="t-value">{current.stats.p90}</div>
              <div className="t-sub">max {current.stats.max}</div>
            </div>
            <div className="tile">
              <div className="t-label">Foxes</div>
              <div className="t-value">{current.stats.meanFoxes.toFixed(1)}</div>
              <div className="t-sub">{current.stats.meanFoxPoints.toFixed(1)} pts avg</div>
            </div>
          </div>

          <div className="chart-block">
            <h4>Score distribution ({current.strategy}, {current.stats.games} games)</h4>
            <Histogram buckets={current.stats.histogram} bucketSize={20} />
          </div>

          <div className="chart-block">
            <h4>Mean points by area</h4>
            <div className="area-bars">
              {(() => {
                const max = Math.max(...CHART_ORDER.map((c) => current.stats!.meanAreas[c.id] ?? 0), 1);
                return CHART_ORDER.map((c) => {
                  const val = current.stats!.meanAreas[c.id] ?? 0;
                  return (
                    <div key={c.id} className="area-bar">
                      <span>{c.label}</span>
                      <span
                        className="bar"
                        style={{ width: `${(100 * val) / max}%`, background: c.color }}
                      />
                      <span className="num">{val.toFixed(1)}</span>
                    </div>
                  );
                });
              })()}
            </div>
          </div>

          <div className="rating-rows">
            {current.stats.ratingCounts.map((r) => (
              <div key={r.label} className="rr">
                <span>{r.label}</span>
                <span>{((100 * r.count) / current.stats!.games).toFixed(1)}%</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
