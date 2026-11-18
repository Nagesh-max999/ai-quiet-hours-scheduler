import { useState } from 'react';
import { api } from '../api.js';
import { CATEGORIES, describeDays, expandProposal, fmtDay, fmtTime } from '../lib/schedule.js';
import { useToast } from './Toasts.jsx';

const EXAMPLES = [
  'Sleep 10:30pm–6:30am every night and study 7–9pm on weekdays',
  'Deep work 9–11am Mon, Wed, Fri for 3 weeks',
  'Family dinner tomorrow 7–8:30pm, remind me 30 minutes before',
];

export default function AIAssistant({ onCreated }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [result, setResult] = useState(null); // { source, proposals, clarification, warning }
  const [selected, setSelected] = useState([]);
  const [conflicts, setConflicts] = useState(null);
  const [busy, setBusy] = useState(false);

  async function generate(e) {
    e?.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setConflicts(null);
    try {
      const res = await api.parse(text);
      setResult(res);
      setSelected(res.proposals.map(() => true));
    } catch (err) {
      toast(err.message, { type: 'error' });
    } finally {
      setBusy(false);
    }
  }

  const chosen = result?.proposals.filter((_, i) => selected[i]) ?? [];
  const expanded = chosen.flatMap((p, gi) => expandProposal(p).map((b) => ({ ...b, group: `p${gi}` })));

  async function addAll(skipConflicts = false) {
    if (!expanded.length) return;
    setBusy(true);
    try {
      const { blocks, skipped } = await api.createBlocks(expanded, skipConflicts);
      toast(`Added ${blocks.length} quiet block${blocks.length === 1 ? '' : 's'}${skipped.length ? `, skipped ${skipped.length} that overlapped` : ''}`, {
        type: 'success',
      });
      setResult(null);
      setText('');
      setConflicts(null);
      onCreated();
    } catch (err) {
      if (err.status === 409 && err.body?.conflicts) setConflicts(err.body.conflicts);
      else toast(err.message, { type: 'error' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card panel">
      <div className="panel-head">
        <h2>✨ AI scheduling assistant</h2>
        {result && <SourceBadge source={result.source} />}
      </div>
      <p className="muted small">Describe your ideal quiet hours in plain English.</p>

      <form onSubmit={generate} className="stack">
        <textarea
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) generate(e);
          }}
          placeholder="e.g. No interruptions 2–4pm on weekdays while I study"
          maxLength={1000}
        />
        <div className="examples">
          {EXAMPLES.map((ex) => (
            <button type="button" key={ex} className="chip chip-sm" onClick={() => setText(ex)}>
              {ex}
            </button>
          ))}
        </div>
        <button className="btn btn-primary btn-block" disabled={busy || !text.trim()}>
          {busy && !result ? 'Thinking…' : 'Generate schedule'}
        </button>
      </form>

      {result?.warning && <p className="notice">{result.warning}</p>}
      {result?.clarification && <p className="notice">{result.clarification}</p>}

      {result?.proposals.length > 0 && (
        <div className="proposals">
          {result.proposals.map((p, i) => {
            const cat = CATEGORIES[p.category] ?? CATEGORIES.other;
            const count = expandProposal(p).length;
            return (
              <label key={i} className={`proposal ${selected[i] ? '' : 'is-off'}`} style={{ '--accent': cat.color }}>
                <input
                  type="checkbox"
                  checked={selected[i]}
                  onChange={() => setSelected((s) => s.map((v, j) => (j === i ? !v : v)))}
                />
                <div>
                  <strong>
                    {cat.icon} {p.title}
                  </strong>
                  <span className="proposal-meta">
                    {p.startTime}–{p.endTime} · {describeDays(p.daysOfWeek)} · {p.repeatWeeks} week{p.repeatWeeks > 1 ? 's' : ''} · {count} block
                    {count === 1 ? '' : 's'}
                  </span>
                  {p.rationale && <span className="proposal-why">{p.rationale}</span>}
                </div>
              </label>
            );
          })}

          {conflicts && (
            <div className="conflicts">
              <strong>
                {conflicts.length} block{conflicts.length > 1 ? 's' : ''} overlap your schedule:
              </strong>
              <ul>
                {conflicts.slice(0, 4).map((c, i) => (
                  <li key={i}>
                    {fmtDay(c.start)} {fmtTime(c.start)}: clashes with “{c.conflictsWith.title}”
                  </li>
                ))}
                {conflicts.length > 4 && <li>…and {conflicts.length - 4} more</li>}
              </ul>
              <button className="btn btn-primary btn-block" onClick={() => addAll(true)} disabled={busy}>
                Add the rest, skip conflicts
              </button>
            </div>
          )}

          {!conflicts && (
            <button className="btn btn-success btn-block" onClick={() => addAll(false)} disabled={busy || !expanded.length}>
              Add {expanded.length} block{expanded.length === 1 ? '' : 's'} to calendar
            </button>
          )}
        </div>
      )}
    </section>
  );
}

export function SourceBadge({ source }) {
  return source === 'claude' ? (
    <span className="pill pill-ai">Claude</span>
  ) : (
    <span className="pill" title="Rule-based engine (no API key configured)">
      Offline engine
    </span>
  );
}
