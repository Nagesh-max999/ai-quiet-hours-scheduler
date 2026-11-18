import { fmtCountdown, fmtHours, fmtTime } from '../lib/schedule.js';

export default function StatsBar({ stats, now }) {
  const items = [
    { label: 'Quiet time this week', value: fmtHours(stats.total), hint: `${Object.keys(stats.byCat).length} categories` },
    { label: 'Focus + study', value: fmtHours(stats.focusHours), hint: stats.focusHours >= 6 ? 'On track' : 'Aim for 6h+' },
    { label: 'Avg. protected sleep', value: stats.avgSleep ? fmtHours(stats.avgSleep) : '—', hint: stats.avgSleep >= 7 ? 'Healthy' : 'Aim for 7–9h' },
    {
      label: 'Next block',
      value: stats.next ? fmtCountdown(new Date(stats.next.start) - now) : '—',
      hint: stats.next ? `${stats.next.title} · ${fmtTime(stats.next.start)}` : 'Nothing scheduled',
    },
  ];
  return (
    <div className="stats">
      {items.map((s) => (
        <div key={s.label} className="card stat">
          <span className="stat-label">{s.label}</span>
          <span className="stat-value">{s.value}</span>
          <span className="stat-hint">{s.hint}</span>
        </div>
      ))}
    </div>
  );
}
