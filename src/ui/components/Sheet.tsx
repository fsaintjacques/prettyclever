import type { ReactElement } from 'react';
import type { AreaDef, Effect, GameState, VariantDef } from '../../engine';
import { engineIndex } from '../describe';

function BonusBadge({ e, earned }: { e: Effect; earned?: boolean }) {
  const cls = (extra: string) => `badge ${extra}${earned ? ' earned' : ''}`;
  switch (e.t) {
    case 'fox':
      return (
        <span className={cls('b-fox')} title="Fox: scores your lowest area at game end">
          🦊
        </span>
      );
    case 'reroll':
      return (
        <span className={cls('b-plain')} title="Unlock a re-roll action">
          ↻
        </span>
      );
    case 'plus1':
      return (
        <span className={cls('b-plain')} title="Unlock a +1 die action">
          +1
        </span>
      );
    case 'crossAny':
    case 'crossNext':
      return (
        <span className={cls(`b-${e.area}`)} title={`Cross a ${e.area} cell`}>
          X
        </span>
      );
    case 'writeNext':
      return (
        <span className={cls(`b-${e.area}`)} title={`Write a ${e.value} in ${e.area}`}>
          {e.value}
        </span>
      );
    case 'choice':
      return (
        <span className={cls('b-plain')} title={e.label}>
          X|6
        </span>
      );
  }
}

type CellClick = (area: string, cell: number) => void;

function GridArea({
  area,
  cells,
  active,
  onCellClick,
}: {
  area: AreaDef;
  cells: number[];
  active: Set<string>;
  onCellClick: CellClick;
}) {
  const ui = area.ui;
  const cols = ui.columns;
  const uiCells = ui.cells;
  const rows = Math.ceil(uiCells.length / cols);

  // Map engine cell index → ui position for group badge placement.
  const uiIndexOf: number[] = [];
  uiCells.forEach((c, i) => {
    if (!c.void) uiIndexOf.push(i);
  });

  const rowBadges: (ReactElement | null)[] = Array(rows).fill(null);
  const colBadges: (ReactElement | null)[] = Array(cols).fill(null);
  let cornerBadge: ReactElement | null = null;
  for (const g of ui.groups ?? []) {
    const complete = g.cells.every((c) => cells[c] !== 0);
    const first = uiIndexOf[g.cells[0]];
    if (g.kind === 'row' && g.bonus) {
      rowBadges[Math.floor(first / cols)] = <BonusBadge e={g.bonus} earned={complete} />;
    } else if (g.kind === 'col') {
      const col = first % cols;
      colBadges[col] = g.points ? (
        <span className={`col-points${complete ? ' earned' : ''}`}>{g.points}</span>
      ) : g.bonus ? (
        <BonusBadge e={g.bonus} earned={complete} />
      ) : null;
    } else if (g.kind === 'diag' && g.bonus) {
      cornerBadge = <BonusBadge e={g.bonus} earned={complete} />;
    }
  }

  const items: ReactElement[] = [];
  uiCells.forEach((c, i) => {
    if (c.void) {
      items.push(<span key={`v${i}`} className="cell void" />);
      return;
    }
    const idx = engineIndex(uiCells, i);
    const key = `${area.id}:${idx}`;
    const crossed = cells[idx] !== 0;
    const isActive = active.has(key);
    const cls = ['cell', crossed && 'filled', c.pre && 'pre', isActive && 'active']
      .filter(Boolean)
      .join(' ');
    items.push(
      <button
        key={key}
        className={cls}
        disabled={!isActive}
        onClick={() => onCellClick(area.id, idx)}
        aria-label={`${area.label} ${c.label ?? 'cell'}${crossed ? ', crossed' : ''}`}
      >
        {crossed ? <span className="x">✕</span> : c.label}
      </button>,
    );
    // badge column at the end of each row
    if ((i + 1) % cols === 0) {
      const r = Math.floor(i / cols);
      items.push(<span key={`rb${r}`}>{rowBadges[r]}</span>);
    }
  });
  // bottom badge row
  for (let c = 0; c < cols; c++) items.push(<span key={`cb${c}`}>{colBadges[c]}</span>);
  items.push(<span key="corner">{cornerBadge}</span>);

  return (
    <div
      className="grid-area"
      style={{ gridTemplateColumns: `repeat(${cols}, 40px) 28px` }}
    >
      {items}
    </div>
  );
}

function TrackArea({
  area,
  cells,
  active,
  onCellClick,
}: {
  area: AreaDef;
  cells: number[];
  active: Set<string>;
  onCellClick: CellClick;
}) {
  const ui = area.ui;
  return (
    <div className="track-area">
      {ui.cells.map((c, i) => {
        const key = `${area.id}:${i}`;
        const filled = cells[i] !== 0;
        const isActive = active.has(key);
        const isThreshold = c.label?.startsWith('≥');
        const cls = ['cell', filled && 'filled', isActive && 'active', isThreshold && 'small-label']
          .filter(Boolean)
          .join(' ');
        return (
          <span key={key} style={{ display: 'contents' }}>
            {c.asc && <span className="asc">&lt;</span>}
            <span className="track-slot">
              <button
                className={cls}
                disabled={!isActive}
                onClick={() => onCellClick(area.id, i)}
                aria-label={`${area.label} slot ${i + 1}${filled ? `, ${cells[i]}` : ''}`}
              >
                {filled ? (
                  isThreshold ? (
                    <span className="x">✕</span>
                  ) : (
                    cells[i]
                  )
                ) : (
                  <>
                    {isThreshold && c.label}
                    {!isThreshold && c.label && <span className="mult">{c.label}</span>}
                  </>
                )}
              </button>
              {c.bonus ? <BonusBadge e={c.bonus} earned={filled} /> : <span style={{ height: 20 }} />}
            </span>
          </span>
        );
      })}
    </div>
  );
}

function PointsScale({ scale, reached }: { scale: number[]; reached: number }) {
  return (
    <div className="points-scale" aria-label="points scale">
      {scale.map((p, i) => (
        <span key={i} className={`scale-pt${i === reached - 1 ? ' reached' : ''}`}>
          {p}
        </span>
      ))}
    </div>
  );
}

function crossedCount(cells: number[]): number {
  return cells.filter((c) => c !== 0).length;
}

export function Sheet({
  state,
  variant,
  scores,
  active,
  onCellClick,
}: {
  state: GameState;
  variant: VariantDef;
  scores: Record<string, number>;
  active: Set<string>;
  onCellClick: CellClick;
}) {
  return (
    <div className="sheet">
      <div className="sheet-top">
        <div className="round-track" aria-label={`round ${state.round} of ${variant.rounds}`}>
          {variant.roundBonuses.map((b, i) => {
            const r = i + 1;
            const cls = ['round-chip', r === state.round && 'current', r < state.round && 'past']
              .filter(Boolean)
              .join(' ');
            return (
              <span key={r} className={cls}>
                <span className="n">{r}</span>
                <span className="b">
                  {b ? (b.t === 'reroll' ? '↻' : b.t === 'plus1' ? '+1' : 'X|6') : '·'}
                </span>
              </span>
            );
          })}
        </div>
        <div className="action-tracks">
          <ActionTrack icon="↻" spent={state.stats.rerollsUsed} available={state.rerolls} />
          <ActionTrack icon="+1" spent={state.stats.plus1Spent} available={state.plus1} />
        </div>
      </div>

      <div className="areas">
        {variant.areas.map((area) => {
          const cells = state.areas[area.id];
          const yellowPre = area.id === 'yellow' ? 4 : 0;
          return (
            <section key={area.id} className={`area area-${area.id}`}>
              <div className="area-head">
                <span className="area-name">{area.label}</span>
                <span className="area-score">{scores[area.id]} pts</span>
              </div>
              {area.ui.pointsScale && (
                <PointsScale
                  scale={area.ui.pointsScale}
                  reached={crossedCount(cells) - yellowPre}
                />
              )}
              {area.ui.kind === 'grid' ? (
                <GridArea area={area} cells={cells} active={active} onCellClick={onCellClick} />
              ) : (
                <TrackArea area={area} cells={cells} active={active} onCellClick={onCellClick} />
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function ActionTrack({ icon, spent, available }: { icon: string; spent: number; available: number }) {
  const slots = 7;
  return (
    <div
      className="action-track"
      aria-label={`${icon === '↻' ? 're-roll' : 'extra die'}: ${available} available, ${spent} used`}
    >
      <span className="at-icon">{icon}</span>
      {Array.from({ length: slots }, (_, i) => {
        const cls = i < spent ? 'slot spent' : i < spent + available ? 'slot unlocked' : 'slot';
        return (
          <span key={i} className={cls}>
            {i < spent ? '✕' : ''}
          </span>
        );
      })}
    </div>
  );
}
