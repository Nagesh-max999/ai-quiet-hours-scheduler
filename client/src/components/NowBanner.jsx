import { CATEGORIES, fmtTime } from '../lib/schedule.js';

export default function NowBanner({ active, now }) {
  if (!active) return null;
  const start = new Date(active.start);
  const end = new Date(active.end);
  const pct = Math.min(100, Math.max(0, ((now - start) / (end - start)) * 100));
  const cat = CATEGORIES[active.category] ?? CATEGORIES.other;

  return (
    <div className="now-banner" style={{ '--accent': cat.color }}>
      <div className="now-icon">{cat.icon}</div>
      <div className="now-body">
        <strong>Quiet mode is on: {active.title}</strong>
        <span className="muted">
          Until {fmtTime(active.end)}. Notifications are on hold, so stay in the zone.
        </span>
        <div className="progress" aria-label={`${Math.round(pct)}% complete`}>
          <div style={{ width: `${pct}%` }} />
        </div>
      </div>
    </div>
  );
}
