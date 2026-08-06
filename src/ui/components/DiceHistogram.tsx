/**
 * Small multiples: one mini histogram per die color showing how often each
 * face was played (marked on the sheet) per game. Shared y-scale across
 * panels so heights compare honestly; panel titles carry identity.
 */

const PANEL_COLOR: Record<string, string> = {
  white: '#c9ccd4',
  yellow: 'var(--ch-yellow)',
  blue: 'var(--ch-blue)',
  green: 'var(--ch-green)',
  orange: 'var(--ch-orange)',
  purple: 'var(--ch-purple)',
  pink: 'var(--ch-pink)',
  silver: 'var(--ch-silver)',
};

function barPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  return [
    `M${x},${y + h}`,
    `L${x},${y + rr}`,
    `Q${x},${y} ${x + rr},${y}`,
    `L${x + w - rr},${y}`,
    `Q${x + w},${y} ${x + w},${y + rr}`,
    `L${x + w},${y + h}`,
    'Z',
  ].join(' ');
}

export function DiceHistogram({ data }: { data: { color: string; counts: number[] }[] }) {
  const max = Math.max(0.001, ...data.flatMap((d) => d.counts));
  const W = 150;
  const H = 112;
  const m = { top: 16, right: 4, bottom: 16, left: 4 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;
  const gap = 3;
  const bw = iw / 6 - gap;

  return (
    <div className="dice-multiples">
      {data.map((d) => (
        <figure key={d.color} className="dice-panel">
          <figcaption>{d.color}</figcaption>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            width="100%"
            role="img"
            aria-label={`${d.color} die: plays per game by face`}
          >
            <line
              x1={m.left}
              x2={W - m.right}
              y1={m.top + ih + 0.5}
              y2={m.top + ih + 0.5}
              stroke="var(--line)"
            />
            {d.counts.map((c, f) => {
              const h = (c / max) * ih;
              const x = m.left + f * (iw / 6) + gap / 2;
              const y = m.top + ih - h;
              return (
                <g key={f}>
                  {c > 0 && (
                    <path d={barPath(x, y, bw, h, 2.5)} fill={PANEL_COLOR[d.color] ?? 'var(--ink-3)'} />
                  )}
                  <text
                    x={x + bw / 2}
                    y={y - 3}
                    textAnchor="middle"
                    fontSize={8.5}
                    fill="var(--ink-2)"
                  >
                    {c >= 0.05 ? c.toFixed(1) : ''}
                  </text>
                  <text
                    x={x + bw / 2}
                    y={H - 4}
                    textAnchor="middle"
                    fontSize={9.5}
                    fill="var(--ink-3)"
                  >
                    {f + 1}
                  </text>
                </g>
              );
            })}
          </svg>
        </figure>
      ))}
    </div>
  );
}
