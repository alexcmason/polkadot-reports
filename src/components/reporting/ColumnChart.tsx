"use client";

import { useId, useState } from "react";

export type Column = { key: string; label: string; value: number; detail?: [string, string][] };

const niceStep = (max: number) => {
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
};

const compact = (v: number, money: boolean) => {
  const a = Math.abs(v);
  const s = a >= 1_000_000 ? `${(a / 1_000_000).toFixed(1)}m` : a >= 1000 ? `${Math.round(a / 1000)}k` : `${Math.round(a)}`;
  return `${v < 0 ? "-" : ""}${money ? "£" : ""}${s}`;
};

/**
 * A single-series column chart. The highlighted column is in the accent green, the rest
 * recede. Each column has a hover and keyboard-focus readout; the same figures sit in a
 * table underneath for anyone who cannot use the chart.
 */
export function ColumnChart({
  title,
  columns,
  highlight,
  money = true,
  format,
}: {
  title: string;
  columns: Column[];
  highlight?: string;
  money?: boolean;
  format: (v: number) => string;
}) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  if (columns.length === 0) return null;

  const W = 720;
  const H = 220;
  const pad = { l: 48, r: 8, t: 12, b: 28 };
  const max = Math.max(0, ...columns.map((c) => c.value));
  const min = Math.min(0, ...columns.map((c) => c.value));
  const step = niceStep(Math.max(max - min, 1));
  const top = Math.ceil(max / step) * step || step;
  const bottom = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let t = bottom; t <= top + step / 2; t += step) ticks.push(Math.round(t * 100) / 100);
  const y = (v: number) => pad.t + ((top - v) / (top - bottom)) * (H - pad.t - pad.b);
  const band = (W - pad.l - pad.r) / columns.length;
  const barW = Math.min(24, band * 0.6);
  const x = (i: number) => pad.l + band * i + band / 2;
  const zero = y(0);

  const shown = hover !== null ? columns[hover] : null;

  return (
    <figure style={{ margin: 0 }}>
      <div className="chart">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${id}-t`}>
          <title id={`${id}-t`}>{title}</title>
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid" x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} />
              <text className="axis" x={pad.l - 8} y={y(t) + 4} textAnchor="end">
                {compact(t, money)}
              </text>
            </g>
          ))}
          {columns.map((c, i) => {
            const on = c.key === highlight || hover === i;
            const h = Math.abs(y(c.value) - zero);
            const neg = c.value < 0;
            const r = Math.min(4, h / 2, barW / 2);
            const x0 = x(i) - barW / 2;
            // Rounded at the data end, square at the baseline.
            const d = neg
              ? `M${x0},${zero} h${barW} v${h - r} q0,${r} -${r},${r} h-${barW - 2 * r} q-${r},0 -${r},-${r} z`
              : `M${x0},${zero} v-${h - r} q0,-${r} ${r},-${r} h${barW - 2 * r} q${r},0 ${r},${r} v${h - r} z`;
            return (
              <g key={c.key}>
                <rect
                  className="hit"
                  x={pad.l + band * i}
                  y={pad.t}
                  width={band}
                  height={H - pad.t - pad.b}
                  tabIndex={0}
                  aria-label={`${c.label}: ${format(c.value)}`}
                  onPointerEnter={() => setHover(i)}
                  onPointerLeave={() => setHover(null)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                />
                {h > 0.5 ? <path className={`bar${neg ? " neg" : ""}${on ? " on" : ""}`} d={d} pointerEvents="none" /> : null}
                <text className="axis" x={x(i)} y={H - 8} textAnchor="middle">
                  {c.label}
                </text>
              </g>
            );
          })}
          <line x1={pad.l} x2={W - pad.r} y1={zero} y2={zero} stroke="#c7d0db" />
        </svg>
        {shown && hover !== null ? (
          <div className="tip" style={{ left: `${(x(hover) / W) * 100}%`, top: `${(Math.min(y(shown.value), zero) / H) * 100}%` }}>
            <strong>{format(shown.value)}</strong>
            <span className="muted">{shown.label}</span>
            {shown.detail?.map(([k, v]) => (
              <div key={k}>
                <span className="muted">{k}</span> {v}
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <details style={{ padding: "0 20px 14px" }}>
        <summary className="link" style={{ display: "inline-flex", minHeight: 32 }}>
          Show as a table
        </summary>
        <table className="tbl compact figs">
          <tbody>
            {columns.map((c) => (
              <tr key={c.key}>
                <td>{c.label}</td>
                <td className="num">{format(c.value)}</td>
                {c.detail?.map(([k, v]) => (
                  <td key={k} className="num">
                    <span className="muted">{k}</span> {v}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
