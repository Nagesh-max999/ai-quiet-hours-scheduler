import { Fragment, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { CATEGORIES, describeDays, expandProposal } from '../lib/schedule.js';
import { useToast } from './Toasts.jsx';

const STARTERS = ["What's coming up this week?", 'How is my week looking?', 'Plan a sleep routine for me', 'Tips to focus better while studying'];
const WELCOME = {
  role: 'assistant',
  content: "Hi, I'm **Quiet**, your scheduling assistant. Ask me about your week, get focus and sleep tips, or tell me what to schedule.",
};

export default function ChatWidget({ userName, onScheduleChanged }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([WELCOME]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const listRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy, open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  async function send(text) {
    const content = text.trim();
    if (!content || busy) return;
    const next = [...messages, { role: 'user', content }];
    setMessages(next);
    setInput('');
    setBusy(true);
    try {
      // Send only text turns; the welcome message is UI-only.
      const history = next.filter((m) => m !== WELCOME).map(({ role, content }) => ({ role, content }));
      const res = await api.chat(history);
      setMessages((m) => [
        ...m,
        { role: 'assistant', content: res.reply, proposals: res.proposals ?? [], source: res.source, warning: res.warning },
      ]);
    } catch (err) {
      setMessages((m) => [...m, { role: 'assistant', content: `⚠️ ${err.message}`, error: true }]);
    } finally {
      setBusy(false);
    }
  }

  async function addProposals(msgIndex, proposals) {
    const items = proposals.flatMap((p, i) => expandProposal(p).map((b) => ({ ...b, group: `chat${msgIndex}-${i}` })));
    if (!items.length) return toast('Those times have already passed.');
    try {
      const { blocks, skipped } = await api.createBlocks(items, true);
      setMessages((m) => m.map((msg, i) => (i === msgIndex ? { ...msg, added: true } : msg)));
      toast(`Added ${blocks.length} block${blocks.length === 1 ? '' : 's'}${skipped.length ? `, skipped ${skipped.length} overlapping` : ''}`, { type: 'success' });
      onScheduleChanged();
    } catch (err) {
      toast(err.status === 409 ? 'All of those overlap blocks already on your calendar.' : err.message, { type: 'error' });
    }
  }

  function reset() {
    setMessages([WELCOME]);
  }

  return (
    <>
      <button className={`chat-fab ${open ? 'is-open' : ''}`} onClick={() => setOpen((o) => !o)} aria-label={open ? 'Close chat' : 'Open AI chat'}>
        {open ? '×' : '💬'}
      </button>

      {open && (
        <section className="chat-panel card" role="dialog" aria-label="AI assistant chat">
          <header className="chat-head">
            <div className="chat-avatar">🌙</div>
            <div className="chat-title">
              <strong>Quiet · AI assistant</strong>
              <span>{busy ? 'typing…' : `Here to help, ${userName.split(' ')[0]}`}</span>
            </div>
            <button className="icon-btn" onClick={reset} title="New conversation" aria-label="New conversation">
              ↻
            </button>
          </header>

          <div className="chat-messages" ref={listRef}>
            {messages.map((m, i) => (
              <div key={i} className={`msg msg-${m.role} ${m.error ? 'msg-error' : ''}`}>
                <div className="msg-bubble">
                  <RichText text={m.content} />
                  {m.warning && <p className="msg-note">{m.warning}</p>}
                </div>
                {m.proposals?.length > 0 && (
                  <div className="msg-proposals">
                    {m.proposals.map((p, j) => {
                      const cat = CATEGORIES[p.category] ?? CATEGORIES.other;
                      return (
                        <div key={j} className="msg-proposal" style={{ '--accent': cat.color }}>
                          <strong>
                            {cat.icon} {p.title}
                          </strong>
                          <span>
                            {p.startTime}–{p.endTime} · {describeDays(p.daysOfWeek)} · {p.repeatWeeks}w
                          </span>
                        </div>
                      );
                    })}
                    <button className="btn btn-success btn-sm" disabled={m.added} onClick={() => addProposals(i, m.proposals)}>
                      {m.added ? '✓ Added to calendar' : 'Add to calendar'}
                    </button>
                  </div>
                )}
                {m.role === 'assistant' && m.source && <span className="msg-source">{m.source === 'claude' ? 'Claude' : 'Offline assistant'}</span>}
              </div>
            ))}
            {busy && (
              <div className="msg msg-assistant">
                <div className="msg-bubble typing" aria-label="Assistant is typing">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            )}
          </div>

          {messages.length <= 1 && (
            <div className="chat-starters">
              {STARTERS.map((s) => (
                <button key={s} className="chip chip-sm" onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          )}

          <form
            className="chat-input"
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
          >
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask anything about your quiet hours…"
              maxLength={2000}
              aria-label="Message"
            />
            <button className="btn btn-primary" disabled={busy || !input.trim()} aria-label="Send">
              ➤
            </button>
          </form>
        </section>
      )}
    </>
  );
}

/** Minimal safe renderer for **bold** and "- " bullet lines (no HTML injection). */
function RichText({ text }) {
  const lines = String(text).split('\n');
  const out = [];
  let bullets = [];
  const flush = () => {
    if (bullets.length) out.push(<ul key={`ul${out.length}`}>{bullets}</ul>);
    bullets = [];
  };
  lines.forEach((line, i) => {
    const m = line.match(/^\s*[-*•]\s+(.*)/);
    if (m) bullets.push(<li key={i}>{inline(m[1])}</li>);
    else {
      flush();
      if (line.trim()) out.push(<p key={i}>{inline(line)}</p>);
    }
  });
  flush();
  return out;
}

function inline(s) {
  return s.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>,
  );
}
