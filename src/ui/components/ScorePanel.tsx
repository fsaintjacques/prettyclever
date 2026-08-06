import type { ScoreBreakdown, VariantDef } from '../../engine';
import { rating } from '../../engine';

const SWATCH: Record<string, string> = {
  yellow: 'var(--yellow)',
  blue: 'var(--blue)',
  green: 'var(--green)',
  orange: 'var(--orange)',
  purple: 'var(--purple)',
  pink: 'var(--pink)',
  silver: 'var(--silver)',
};

export function ScorePanel({
  variant,
  score,
  final,
}: {
  variant: VariantDef;
  score: ScoreBreakdown;
  final: boolean;
}) {
  return (
    <div className="panel">
      <h3>Score</h3>
      <div className="score-rows">
        {variant.areas.map((a) => (
          <div key={a.id} className="score-row">
            <span className="swatch" style={{ background: SWATCH[a.id] ?? 'var(--ink-3)' }} />
            <span>{a.label}</span>
            <span className="val">{score.areas[a.id]}</span>
          </div>
        ))}
        <div className="score-row">
          <span className="swatch" style={{ background: 'var(--fox)' }} />
          <span>
            Foxes {score.foxCount} × {score.minArea}
          </span>
          <span className="val">{score.foxPoints}</span>
        </div>
      </div>
      <div className="score-total">
        <span className="big">{score.total}</span>
        <span className="rating">
          {final ? rating(variant, score.total) : 'if the game ended now'}
        </span>
      </div>
    </div>
  );
}
