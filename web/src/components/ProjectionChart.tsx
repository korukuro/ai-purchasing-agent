import { useState } from "react";
import type { Projection } from "../types";

const W = 640;
const H = 240;
const M = { top: 16, right: 16, bottom: 28, left: 44 };

/**
 * Projected closing stock by day: before the agent acted vs after.
 * One y-axis, two series (legend + direct labels), crosshair tooltip on hover.
 */
export function ProjectionChart({ before, after }: { before: Projection; after: Projection }) {
  const [hover, setHover] = useState<number | null>(null);
  const days = after.days.map((d) => d.day);
  const cap = after.storage.freeCapacityForThisSku;
  const maxStock = Math.max(...before.days.map((d) => d.closingStock + d.demand), ...after.days.map((d) => d.closingStock + d.demand), 10);
  const showCap = cap < maxStock * 1.6;
  const yMax = niceMax(Math.max(maxStock, showCap ? cap : 0));
  const x = (day: number) => M.left + ((day - 1) / Math.max(1, days.length - 1)) * (W - M.left - M.right);
  const y = (v: number) => M.top + (1 - v / yMax) * (H - M.top - M.bottom);
  const path = (p: Projection) => p.days.map((d, i) => `${i ? "L" : "M"}${x(d.day).toFixed(1)},${y(d.closingStock).toFixed(1)}`).join(" ");
  const ticks = [0, yMax / 4, yMax / 2, (3 * yMax) / 4, yMax];
  const lastDay = days[days.length - 1];
  const hb = hover ? before.days[hover - 1] : null;
  const ha = hover ? after.days[hover - 1] : null;

  return (
    <div className="relative">
      <div className="mb-2 flex flex-wrap items-center gap-4 text-xs text-stone-600">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 rounded" style={{ background: "var(--series-before)" }} /> Without agent action
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 rounded" style={{ background: "var(--series-after)" }} /> After agent's plan (actual confirmations)
        </span>
        <span className="text-stone-400">demand: {after.demandBasis}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Projected closing stock by day, before and after the agent's plan">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} stroke="#e7e5e4" strokeWidth={1} />
            <text x={M.left - 6} y={y(t) + 4} textAnchor="end" fontSize={10} fill="#78716c">
              {Math.round(t)}
            </text>
          </g>
        ))}
        {days.filter((d) => d === 1 || d % 5 === 0).map((d) => (
          <text key={d} x={x(d)} y={H - 8} textAnchor="middle" fontSize={10} fill="#78716c">
            day {d}
          </text>
        ))}
        {showCap && (
          <g>
            <line x1={M.left} x2={W - M.right} y1={y(cap)} y2={y(cap)} stroke="#a8a29e" strokeDasharray="4 4" strokeWidth={1} />
            <text x={W - M.right} y={y(cap) - 4} textAnchor="end" fontSize={10} fill="#78716c">
              storage limit {cap}
            </text>
          </g>
        )}
        <path d={path(before)} fill="none" stroke="var(--series-before)" strokeWidth={2} strokeLinejoin="round" />
        <path d={path(after)} fill="none" stroke="var(--series-after)" strokeWidth={2} strokeLinejoin="round" />
        {[before, after].map((p, i) =>
          p.firstStockoutDay ? (
            <g key={i}>
              <circle cx={x(p.firstStockoutDay)} cy={y(0)} r={4.5} fill="var(--critical)" stroke="#fff" strokeWidth={2} />
              <text x={x(p.firstStockoutDay)} y={y(0) - 9 - i * 12} textAnchor="middle" fontSize={10} fill="#44403c">
                ⚠ stockout day {p.firstStockoutDay}
              </text>
            </g>
          ) : null,
        )}
        <text x={x(lastDay) - 4} y={y(after.days[after.days.length - 1].closingStock) - 6} textAnchor="end" fontSize={10} fill="#44403c">
          after
        </text>
        {hover && (
          <line x1={x(hover)} x2={x(hover)} y1={M.top} y2={H - M.bottom} stroke="#57534e" strokeWidth={1} strokeDasharray="2 3" />
        )}
        {days.map((d) => (
          <rect
            key={d}
            x={x(d) - (W - M.left - M.right) / days.length / 2}
            y={M.top}
            width={(W - M.left - M.right) / days.length}
            height={H - M.top - M.bottom}
            fill="transparent"
            onMouseEnter={() => setHover(d)}
            onMouseLeave={() => setHover(null)}
          />
        ))}
      </svg>
      {hover && hb && ha && (
        <div
          className="pointer-events-none absolute top-8 rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-xs shadow-md"
          style={{ left: `${Math.min(75, (x(hover) / W) * 100)}%` }}
        >
          <div className="font-semibold text-stone-800">Day {hover}</div>
          <div className="text-stone-600">demand {ha.demand}</div>
          <div className="text-stone-600">without action: {hb.closingStock}{hb.lostSales ? ` (lost ${hb.lostSales})` : ""}</div>
          <div className="text-stone-600">after plan: {ha.closingStock}{ha.lostSales ? ` (lost ${ha.lostSales})` : ""}</div>
          {ha.arrivals > 0 && <div className="text-stone-600">arrivals: +{ha.arrivals}</div>}
        </div>
      )}
    </div>
  );
}

function niceMax(v: number) {
  const pow = 10 ** Math.floor(Math.log10(Math.max(1, v)));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * pow >= v) return m * pow;
  return 10 * pow;
}
