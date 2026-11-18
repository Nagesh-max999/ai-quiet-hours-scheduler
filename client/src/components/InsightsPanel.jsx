import { useState } from 'react';
import { api } from '../api.js';
import { describeDays, expandProposal } from '../lib/schedule.js';
import { SourceBadge } from './AIAssistant.jsx';
import { useToast } from './Toasts.jsx';

export default function InsightsPanel({ blocks, onApplied }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState({});

  async function analyze() {
    setBusy(true);
    try {
      setData(await api.insights());
      setApplied({});
    } catch (err) {
      toast(err.message, { type: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function apply(i, proposal) {
    const items = expandProposal(proposal).map((b) => ({ ...b, group: 'suggestion' }));
    if (!items.length) return toast('Those times have already passed this week.');
    try {
      const { blocks: created, skipped } = await api.createBlocks(items, true);
      setApplied((a) => ({ ...a, [i]: true }));
      toast(`Added ${created.length} block${created.length === 1 ? '' : 's'}${skipped.length ? ` (${skipped.length} skipped for overlaps)` : ''}`, { type: 'success' });
      onApplied();
    } catch (err) {
      toast(err.status === 409 ? 'Every suggested block overlaps something already on your calendar.' : err.message, { type: 'error' });
    }
  }

  return (
    <section className="card panel">
      <div className="panel-head">
        <h2>📊 Weekly insights</h2>
        {data && <SourceBadge source={data.source} />}
      </div>

      {!data && (
        <>
          <p className="muted small">Get a quiet-time health score for the next 7 days, with suggestions you can apply in one click.</p>
          <button className="btn btn-ghost btn-block" onClick={analyze} disabled={busy}>
            {busy ? 'Analyzing…' : blocks.length ? 'Analyze my week' : 'Get starter suggestions'}
          </button>
        </>
      )}

      {data && (
        <div className="stack">
          <div className="score-row">
            <ScoreRing score={data.score} />
            <div>
              <strong>{data.headline}</strong>
              <span className="muted small block">
                {data.summary.totalQuietHours}h protected across {data.summary.blockCount} blocks
              </span>
            </div>
          </div>
          {data.warning && <p className="notice">{data.warning}</p>}
          <ul className="suggestions">
            {data.suggestions.map((s, i) => (
              <li key={i}>
                <strong>{s.title}</strong>
                <p>{s.detail}</p>
                {s.proposal && (
                  <button className="btn btn-sm btn-ghost" disabled={applied[i]} onClick={() => apply(i, s.proposal)}>
                    {applied[i] ? '✓ Applied' : `Apply: ${s.proposal.startTime}–${s.proposal.endTime}, ${describeDays(s.proposal.daysOfWeek)}`}
                  </button>
                )}
              </li>
            ))}
          </ul>
          <button className="link-btn" onClick={analyze} disabled={busy}>
            {busy ? 'Analyzing…' : '↻ Re-analyze'}
          </button>
        </div>
      )}
    </section>
  );
}

function ScoreRing({ score }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const tone = score >= 75 ? 'var(--good)' : score >= 50 ? 'var(--warn)' : 'var(--bad)';
  return (
    <svg className="score-ring" width="64" height="64" viewBox="0 0 64 64" role="img" aria-label={`Score ${score} out of 100`}>
      <circle cx="32" cy="32" r={r} fill="none" stroke="var(--border)" strokeWidth="6" />
      <circle
        cx="32"
        cy="32"
        r={r}
        fill="none"
        stroke={tone}
        strokeWidth="6"
        strokeLinecap="round"
        strokeDasharray={`${(score / 100) * c} ${c}`}
        transform="rotate(-90 32 32)"
      />
      <text x="32" y="37" textAnchor="middle" fontSize="16" fontWeight="700" fill="currentColor">
        {score}
      </text>
    </svg>
  );
}
