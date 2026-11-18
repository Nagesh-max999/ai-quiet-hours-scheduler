import { useEffect, useMemo, useRef } from 'react';
import { addDays, CATEGORIES, DAY_SHORT, fmtTime, layoutWeek, sameDay, startOfWeek } from '../lib/schedule.js';

const HOUR_PX = 44;
const HOURS = Array.from({ length: 24 }, (_, h) => h);

export default function WeekCalendar({ weekStart, blocks, now, loading, onWeekChange, onSelectBlock, onCreateAt }) {
  const scrollRef = useRef(null);
  const days = useMemo(() => layoutWeek(blocks, weekStart), [blocks, weekStart]);
  const isThisWeek = sameDay(weekStart, startOfWeek(now));

  useEffect(() => {
    // Start the view around 7am instead of midnight.
    if (scrollRef.current) scrollRef.current.scrollTop = HOUR_PX * 6.5;
  }, []);

  function handleColumnClick(e, date) {
    if (e.target !== e.currentTarget) return; // clicked a block, not empty space
    const y = e.nativeEvent.offsetY;
    const minutes = Math.floor(y / HOUR_PX / 0.5) * 30;
    const start = new Date(date);
    start.setMinutes(minutes);
    onCreateAt(start);
  }

  const end = addDays(weekStart, 6);
  const label = `${weekStart.toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString([], {
    month: weekStart.getMonth() === end.getMonth() ? undefined : 'short',
    day: 'numeric',
    year: 'numeric',
  })}`;

  return (
    <div className="calendar">
      <div className="calendar-toolbar">
        <div>
          <h2>Your week</h2>
          <span className="muted">{label}</span>
        </div>
        <div className="btn-group">
          <button className="btn btn-ghost" onClick={() => onWeekChange(addDays(weekStart, -7))} aria-label="Previous week">
            ‹
          </button>
          <button className="btn btn-ghost" onClick={() => onWeekChange(startOfWeek())} disabled={isThisWeek}>
            Today
          </button>
          <button className="btn btn-ghost" onClick={() => onWeekChange(addDays(weekStart, 7))} aria-label="Next week">
            ›
          </button>
          <button className="btn btn-primary" onClick={() => onCreateAt(nextHalfHour(now))}>
            + New block
          </button>
        </div>
      </div>

      <div className="cal-head">
        <div className="cal-gutter" />
        {days.map(({ date }) => (
          <div key={date.toISOString()} className={`cal-day-head ${sameDay(date, now) ? 'is-today' : ''}`}>
            <span>{DAY_SHORT[date.getDay()]}</span>
            <strong>{date.getDate()}</strong>
          </div>
        ))}
      </div>

      <div className="cal-scroll" ref={scrollRef}>
        <div className="cal-grid" style={{ height: HOUR_PX * 24 }}>
          <div className="cal-gutter">
            {HOURS.map((h) => (
              <div key={h} className="cal-hour-label" style={{ top: h * HOUR_PX }}>
                {h === 0 ? '' : new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' })}
              </div>
            ))}
          </div>
          {days.map(({ date, segments }) => (
            <div
              key={date.toISOString()}
              className={`cal-col ${sameDay(date, now) ? 'is-today' : ''}`}
              style={{ backgroundSize: `100% ${HOUR_PX}px` }}
              onClick={(e) => handleColumnClick(e, date)}
              title="Click to add a quiet block"
            >
              {segments.map((seg) => {
                const cat = CATEGORIES[seg.block.category] ?? CATEGORIES.other;
                const compact = seg.height < 45;
                return (
                  <button
                    key={seg.block.id}
                    className={`cal-block ${seg.continuesBefore ? 'cont-before' : ''} ${seg.continuesAfter ? 'cont-after' : ''} ${compact ? 'compact' : ''}`}
                    style={{ top: (seg.top / 60) * HOUR_PX, height: (seg.height / 60) * HOUR_PX - 2, '--accent': cat.color }}
                    onClick={() => onSelectBlock(seg.block)}
                    title={`${seg.block.title}: ${fmtTime(seg.block.start)} – ${fmtTime(seg.block.end)}`}
                  >
                    <span className="cal-block-title">
                      {cat.icon} {seg.block.title}
                    </span>
                    {!compact && (
                      <span className="cal-block-time">
                        {fmtTime(seg.block.start)} – {fmtTime(seg.block.end)}
                      </span>
                    )}
                  </button>
                );
              })}
              {sameDay(date, now) && (
                <div className="now-line" style={{ top: ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_PX }} />
              )}
            </div>
          ))}
        </div>
        {loading && <div className="cal-loading">Loading…</div>}
      </div>
    </div>
  );
}

function nextHalfHour(now) {
  const d = new Date(now);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60);
  return d;
}
