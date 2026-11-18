import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { CATEGORIES, fmtDay, fmtTime, toDateInput, toTimeInput } from '../lib/schedule.js';
import { useToast } from './Toasts.jsx';

const REMINDERS = [0, 5, 10, 15, 30, 60];

export default function BlockModal({ block, defaults, defaultReminder, onClose, onSaved }) {
  const toast = useToast();
  const editing = Boolean(block);
  const initialStart = new Date(block?.start ?? defaults.start);
  const initialEnd = new Date(block?.end ?? initialStart.getTime() + 60 * 60 * 1000);

  const [form, setForm] = useState({
    title: block?.title ?? '',
    category: block?.category ?? 'focus',
    date: toDateInput(initialStart),
    startTime: toTimeInput(initialStart),
    endTime: toTimeInput(initialEnd),
    reminderMinutes: block?.reminderMinutes ?? defaultReminder,
    notes: block?.notes ?? '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const overnight = form.endTime <= form.startTime;

  function toRange() {
    const [y, m, d] = form.date.split('-').map(Number);
    const [sh, sm] = form.startTime.split(':').map(Number);
    const [eh, em] = form.endTime.split(':').map(Number);
    const start = new Date(y, m - 1, d, sh, sm);
    const end = new Date(y, m - 1, d + (overnight ? 1 : 0), eh, em);
    return { start: start.toISOString(), end: end.toISOString() };
  }

  async function save(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    const payload = {
      title: form.title.trim() || CATEGORIES[form.category].label,
      category: form.category,
      reminderMinutes: Number(form.reminderMinutes),
      notes: form.notes,
      ...toRange(),
    };
    try {
      if (editing) await api.updateBlock(block.id, payload);
      else await api.createBlock(payload);
      toast(editing ? 'Block updated' : 'Quiet block added', { type: 'success' });
      onSaved();
    } catch (err) {
      const c = err.body?.conflicts?.[0]?.conflictsWith;
      setError(c ? `Overlaps "${c.title}" (${fmtDay(c.start)}, ${fmtTime(c.start)} – ${fmtTime(c.end)})` : err.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(series) {
    setBusy(true);
    try {
      const { removed } = await api.deleteBlock(block.id, series);
      toast(series ? `Removed ${removed} blocks from this series` : 'Block deleted');
      onSaved();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="card modal" onSubmit={save} role="dialog" aria-modal="true" aria-labelledby="block-modal-title">
        <div className="modal-head">
          <h2 id="block-modal-title">{editing ? 'Edit quiet block' : 'New quiet block'}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <label>
          Title
          <input value={form.title} onChange={set('title')} placeholder={CATEGORIES[form.category].label} maxLength={80} autoFocus />
        </label>

        <div className="category-picker" role="radiogroup" aria-label="Category">
          {Object.entries(CATEGORIES).map(([key, c]) => (
            <button
              type="button"
              key={key}
              role="radio"
              aria-checked={form.category === key}
              className={`chip ${form.category === key ? 'chip-active' : ''}`}
              style={{ '--accent': c.color }}
              onClick={() => setForm((f) => ({ ...f, category: key }))}
            >
              {c.icon} {c.label}
            </button>
          ))}
        </div>

        <div className="row-3">
          <label>
            Date
            <input type="date" value={form.date} onChange={set('date')} required />
          </label>
          <label>
            Starts
            <input type="time" value={form.startTime} onChange={set('startTime')} required />
          </label>
          <label>
            Ends {overnight && <span className="tag">next day</span>}
            <input type="time" value={form.endTime} onChange={set('endTime')} required />
          </label>
        </div>

        <label>
          Reminder
          <select value={form.reminderMinutes} onChange={set('reminderMinutes')}>
            {REMINDERS.map((m) => (
              <option key={m} value={m}>
                {m === 0 ? 'No reminder' : `${m} minutes before`}
              </option>
            ))}
          </select>
        </label>

        <label>
          Notes
          <textarea rows={2} value={form.notes} onChange={set('notes')} placeholder="Optional" maxLength={500} />
        </label>

        {error && <p className="form-error">{error}</p>}

        <div className="modal-actions">
          {editing && (
            <div className="btn-group">
              <button type="button" className="btn btn-danger" onClick={() => remove(false)} disabled={busy}>
                Delete
              </button>
              {block.seriesId && (
                <button type="button" className="btn btn-ghost" onClick={() => remove(true)} disabled={busy}>
                  Delete this &amp; following
                </button>
              )}
            </div>
          )}
          <div className="btn-group push-right">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
