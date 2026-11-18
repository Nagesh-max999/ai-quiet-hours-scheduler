import { CATEGORIES, fmtCountdown, fmtDay, fmtTime } from '../lib/schedule.js';

export default function UpcomingList({ blocks, now, onSelect }) {
  const upcoming = blocks.filter((b) => new Date(b.end) > now).slice(0, 5);
  return (
    <section className="card panel">
      <h2>⏰ Up next</h2>
      {upcoming.length === 0 ? (
        <p className="muted small">No upcoming quiet blocks. Ask the assistant to plan your week.</p>
      ) : (
        <ul className="upcoming">
          {upcoming.map((b) => {
            const cat = CATEGORIES[b.category] ?? CATEGORIES.other;
            const active = new Date(b.start) <= now;
            return (
              <li key={b.id}>
                <button className="upcoming-item" style={{ '--accent': cat.color }} onClick={() => onSelect(b)}>
                  <span className="upcoming-icon">{cat.icon}</span>
                  <span className="upcoming-main">
                    <strong>{b.title}</strong>
                    <span className="muted small">
                      {fmtDay(b.start)} · {fmtTime(b.start)} – {fmtTime(b.end)}
                    </span>
                  </span>
                  <span className={`tag ${active ? 'tag-live' : ''}`}>{active ? 'Now' : fmtCountdown(new Date(b.start) - now)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
