import type { GameState, VariantDef } from '../../engine';

const PIP_LAYOUT: Record<number, [number, number][]> = {
  1: [[1, 1]],
  2: [
    [0, 2],
    [2, 0],
  ],
  3: [
    [0, 2],
    [1, 1],
    [2, 0],
  ],
  4: [
    [0, 0],
    [0, 2],
    [2, 0],
    [2, 2],
  ],
  5: [
    [0, 0],
    [0, 2],
    [1, 1],
    [2, 0],
    [2, 2],
  ],
  6: [
    [0, 0],
    [0, 2],
    [1, 0],
    [1, 2],
    [2, 0],
    [2, 2],
  ],
};

export function Die({
  color,
  face,
  selectable,
  selected,
  used,
  dim,
  onClick,
}: {
  color: string;
  face: number;
  selectable?: boolean;
  selected?: boolean;
  used?: boolean;
  dim?: boolean;
  onClick?: () => void;
}) {
  const cls = [
    'die',
    `die-${color}`,
    selectable && 'selectable',
    selected && 'selected',
    used && 'used',
    dim && 'dim',
  ]
    .filter(Boolean)
    .join(' ');
  const pips = PIP_LAYOUT[face] ?? [];
  return (
    <button
      className={cls}
      onClick={onClick}
      disabled={!selectable}
      aria-label={`${color} die showing ${face}${selected ? ', selected' : ''}`}
    >
      <span className="pips">
        {pips.map(([r, c], i) => (
          <span key={i} className="pip" style={{ gridRow: r + 1, gridColumn: c + 1 }} />
        ))}
      </span>
    </button>
  );
}

export function DiceTray({
  state,
  variant,
  selectable,
  selected,
  onDieClick,
}: {
  state: GameState;
  variant: VariantDef;
  selectable: Set<number>;
  selected: number | null;
  onDieClick: (die: number) => void;
}) {
  const zones: { id: 'pool' | 'field' | 'platter'; label: string }[] = [
    { id: 'pool', label: 'Rolled' },
    { id: 'field', label: 'Taken' },
    { id: 'platter', label: 'Silver platter' },
  ];
  const blue = variant.colors.indexOf('blue');
  const white = variant.colors.indexOf('white');
  const sum = blue >= 0 && white >= 0 ? state.faces[blue] + state.faces[white] : null;
  return (
    <div className="tray">
      {zones.map((z) => {
        const dice = variant.colors.map((_, i) => i).filter((i) => state.loc[i] === z.id);
        if (z.id !== 'pool' && dice.length === 0) return null;
        return (
          <div key={z.id} className={`tray-zone ${z.id}`}>
            <span className="zone-label">{z.label}</span>
            <div className="dice-row">
              {dice.map((i) => (
                <Die
                  key={i}
                  color={variant.colors[i]}
                  face={state.faces[i]}
                  selectable={selectable.has(i)}
                  selected={selected === i}
                  used={state.plus1Used[i]}
                  dim={z.id === 'platter' && !selectable.has(i)}
                  onClick={() => onDieClick(i)}
                />
              ))}
              {dice.length === 0 && <span className="hint">—</span>}
            </div>
          </div>
        );
      })}
      {sum !== null && sum > 0 && <span className="sum-chip">blue + white = {sum}</span>}
    </div>
  );
}
