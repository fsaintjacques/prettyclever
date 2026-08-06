import type { ReactElement } from 'react';
import type { AreaDef, BarDef, Effect, GameState, VariantDef } from '../../engine';
import { uiToEngine } from '../describe';

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
    case 'return':
      return (
        <span className={cls('b-plain')} title="Unlock a return action">
          ↩
        </span>
      );
    case 'free':
      return (
        <span className={cls(`b-${e.area}`)} title={`Free mark in ${e.area} (?)`}>
          ?
        </span>
      );
    case 'silverMark':
      return null; // platter-chain marks are never printed on the sheet
    case 'choice':
      return (
        <span className={cls('b-plain')} title={e.label}>
          {e.options.every((o) => o.t === 'free') ? '?' : 'X|6'}
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
  // Silver grid: per-row running score + column bonuses printed above the grid.
  const perRowScale = ui.scalePerRow && ui.pointsScale ? ui.pointsScale : null;

  // Map engine cell index → ui position for group badge placement. When the
  // ui has exactly area.size cells the voids are real (always-empty) engine
  // cells and the mapping is the identity (see uiToEngine).
  const identity = uiCells.length === area.size;
  const uiIndexOf: number[] = [];
  uiCells.forEach((c, i) => {
    if (identity || !c.void) uiIndexOf.push(i);
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

  if (perRowScale) {
    // The badge column shows each row's current points instead of a bonus.
    for (let r = 0; r < rows; r++) {
      let count = 0;
      for (let i = r * cols; i < (r + 1) * cols && i < uiCells.length; i++) {
        if (!uiCells[i].void && cells[uiToEngine(uiCells, area.size, i)] !== 0) count++;
      }
      const pts = count > 0 ? perRowScale[count - 1] : 0;
      rowBadges[r] = (
        <span className={`row-score${count > 0 ? ' scored' : ''}`} title="points for this row">
          {pts}
        </span>
      );
    }
  }

  const items: ReactElement[] = [];
  if (perRowScale) {
    // Column-completion bonuses sit above the columns on this sheet.
    for (let c = 0; c < cols; c++)
      items.push(
        <span key={`tb${c}`} className="col-badge">
          {colBadges[c]}
        </span>,
      );
    items.push(<span key="tb-end" />);
  }
  const endOfRowBadge = (i: number) => {
    if ((i + 1) % cols === 0) {
      const r = Math.floor(i / cols);
      items.push(<span key={`rb${r}`}>{rowBadges[r]}</span>);
    }
  };
  uiCells.forEach((c, i) => {
    if (c.void) {
      items.push(<span key={`v${i}`} className="cell void" />);
      endOfRowBadge(i);
      return;
    }
    const idx = uiToEngine(uiCells, area.size, i);
    const key = `${area.id}:${idx}`;
    const state = cells[idx];
    const crossed = state !== 0;
    const isActive = active.has(key);
    const rowColor = area.silverRows?.[Math.floor(i / cols)];
    const cls = [
      'cell',
      crossed && 'filled',
      c.pre && 'pre',
      isActive && 'active',
      rowColor && `row-${rowColor}`,
    ]
      .filter(Boolean)
      .join(' ');
    const stateLabel = ui.twoState
      ? state === 1
        ? ', circled'
        : state === 2
          ? ', crossed'
          : ''
      : crossed
        ? ', crossed'
        : '';
    items.push(
      <button
        key={key}
        className={cls}
        disabled={!isActive}
        onClick={() => onCellClick(area.id, idx)}
        aria-label={`${area.label} ${c.label ?? 'cell'}${stateLabel}`}
      >
        {ui.twoState ? (
          state === 0 ? (
            c.label
          ) : (
            <span className={`ring${state === 2 ? ' crossed' : ''}`}>
              {c.label}
              {state === 2 && <span className="ring-x">✕</span>}
            </span>
          )
        ) : crossed ? (
          <span className="x">✕</span>
        ) : (
          c.label
        )}
      </button>,
    );
    // badge column at the end of each row
    endOfRowBadge(i);
  });
  if (!perRowScale) {
    // bottom badge row
    for (let c = 0; c < cols; c++) items.push(<span key={`cb${c}`}>{colBadges[c]}</span>);
    items.push(<span key="corner">{cornerBadge}</span>);
  }

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
        // A written value below the printed ≥ threshold fills the slot but
        // withholds its bonus (Twice pink). Cross tracks are ungated here —
        // their entry requirement already gated the placement.
        const gate = !ui.crossTrack && isThreshold ? Number(c.label!.slice(1)) : 0;
        const bonusEarned = filled && (gate === 0 || cells[i] >= gate);
        // Second slot of a subtraction pair: show a "−" before it and the
        // pair's star (first − second once complete) after it.
        const pairSecond = c.pair !== undefined && i % 2 === 1;
        const pairDone = pairSecond && filled && cells[i - 1] !== 0;
        const cls = ['cell', filled && 'filled', isActive && 'active', isThreshold && 'small-label']
          .filter(Boolean)
          .join(' ');
        return (
          <span key={key} style={{ display: 'contents' }}>
            {c.asc && <span className="asc">&lt;</span>}
            {c.desc && <span className="asc">≥</span>}
            {pairSecond && <span className="asc">−</span>}
            <span className="track-slot">
              <button
                className={cls}
                disabled={!isActive}
                onClick={() => onCellClick(area.id, i)}
                aria-label={`${area.label} slot ${i + 1}${filled ? `, ${cells[i]}` : ''}`}
              >
                {filled ? (
                  ui.crossTrack ? (
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
              {c.bonus ? (
                <BonusBadge e={c.bonus} earned={bonusEarned} />
              ) : (
                <span style={{ height: 20 }} />
              )}
            </span>
            {pairSecond && (
              <span
                className={`pair-star${pairDone ? ' done' : ''}`}
                title="pair scores first − second"
              >
                {pairDone ? cells[i - 1] - cells[i] : '★'}
              </span>
            )}
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

/** Compact glyph for a round-track bonus. */
function roundIcon(e: Effect): string {
  switch (e.t) {
    case 'fox':
      return '🦊';
    case 'reroll':
      return '↻';
    case 'plus1':
      return '+1';
    case 'return':
      return '↩';
    case 'free':
      return '?';
    case 'choice':
      return e.options.every((o) => o.t === 'free') ? '?' : 'X|6';
    default:
      return 'X';
  }
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
                <span className="b">{b ? roundIcon(b) : '·'}</span>
              </span>
            );
          })}
        </div>
        <div className="action-tracks">
          <ActionTrack
            label="re-roll"
            icon="↻"
            bar={variant.bars.reroll}
            spent={state.stats.rerollsUsed}
            available={state.rerolls}
            unlocked={state.barUnlocks.reroll}
          />
          <ActionTrack
            label="extra die"
            icon="+1"
            bar={variant.bars.plus1}
            spent={state.stats.plus1Spent}
            available={state.plus1}
            unlocked={state.barUnlocks.plus1}
          />
          {variant.bars.return.size > 0 && (
            <ActionTrack
              label="return"
              icon="↩"
              bar={variant.bars.return}
              spent={state.stats.returnsUsed}
              available={state.returns}
              unlocked={state.barUnlocks.return}
            />
          )}
        </div>
      </div>

      <div className="areas">
        {variant.areas.map((area) => {
          const cells = state.areas[area.id];
          // The scale highlights the step the current count has reached:
          // crosses only in two-state areas, pre-printed crosses excluded,
          // and nothing for a per-row scale (each row keeps its own count).
          const pre = area.ui.cells.filter((c) => c.pre).length;
          const reached = area.ui.scalePerRow
            ? 0
            : area.ui.twoState
              ? cells.filter((c) => c === 2).length
              : crossedCount(cells) - pre;
          return (
            <section key={area.id} className={`area area-${area.id} kind-${area.ui.kind}`}>
              <div className="area-head">
                <span className="area-name">{area.label}</span>
                <span className="area-score">{scores[area.id]} pts</span>
              </div>
              {area.ui.pointsScale && <PointsScale scale={area.ui.pointsScale} reached={reached} />}
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

function ActionTrack({
  label,
  icon,
  bar,
  spent,
  available,
  unlocked,
}: {
  label: string;
  icon: string;
  bar: BarDef;
  spent: number;
  available: number;
  unlocked: number;
}) {
  return (
    <div className="action-track" aria-label={`${label}: ${available} available, ${spent} used`}>
      <span className="at-icon">{icon}</span>
      {Array.from({ length: bar.size }, (_, i) => {
        const cls = i < spent ? 'slot spent' : i < spent + available ? 'slot unlocked' : 'slot';
        return (
          <span key={i} className={cls}>
            {i < spent ? '✕' : ''}
          </span>
        );
      })}
      {bar.endBonus && <BonusBadge e={bar.endBonus} earned={unlocked >= bar.size} />}
    </div>
  );
}
