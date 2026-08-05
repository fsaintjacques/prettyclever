import { useRef, useState } from 'react';

interface Bucket {
  start: number;
  count: number;
}

/** Rounded-top bar anchored to the baseline (flat bottom). */
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

export function Histogram({ buckets, bucketSize }: { buckets: Bucket[]; bucketSize: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const W = 480;
  const H = 170;
  const m = { top: 8, right: 6, bottom: 22, left: 30 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const n = buckets.length;
  const gap = 2;
  const bw = Math.max(2, iw / n - gap);
  const yTicks = [0, Math.round(max / 2), max];
  const labelEvery = Math.ceil(n / 8);

  return (
    <div ref={wrapRef} style={{ position: 'relative', maxWidth: W }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label="score distribution histogram"
        onMouseLeave={() => setHover(null)}
      >
        {yTicks.map((t) => {
          const y = m.top + ih - (t / max) * ih;
          return (
            <g key={t}>
              <line x1={m.left} x2={W - m.right} y1={y} y2={y} stroke="var(--line)" strokeWidth={1} />
              <text x={m.left - 6} y={y + 3.5} textAnchor="end" fontSize={10} fill="var(--ink-3)">
                {t}
              </text>
            </g>
          );
        })}
        {buckets.map((b, i) => {
          const h = (b.count / max) * ih;
          const x = m.left + (i * iw) / n + gap / 2;
          const y = m.top + ih - h;
          return (
            <g key={b.start}>
              {b.count > 0 && (
                <path
                  d={barPath(x, y, bw, h, 3)}
                  fill="var(--ch-blue)"
                  opacity={hover === null || hover === i ? 1 : 0.45}
                />
              )}
              <rect
                x={x - gap / 2}
                y={m.top}
                width={bw + gap}
                height={ih}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
              />
              {i % labelEvery === 0 && (
                <text
                  x={x + bw / 2}
                  y={H - 7}
                  textAnchor="middle"
                  fontSize={10}
                  fill="var(--ink-3)"
                >
                  {b.start}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hover !== null && buckets[hover] && (
        <div
          className="chart-tip"
          style={{
            left: `${((m.left + ((hover + 0.5) * iw) / n) / W) * 100}%`,
            top: 0,
          }}
        >
          {buckets[hover].start}–{buckets[hover].start + bucketSize - 1}: {buckets[hover].count}
        </div>
      )}
    </div>
  );
}
