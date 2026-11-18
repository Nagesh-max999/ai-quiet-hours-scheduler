import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../App.jsx';
import { useToast } from '../components/Toasts.jsx';
import { notifyBrowser, useEvents } from '../hooks/useEvents.js';
import { addDays, startOfWeek, weekStats } from '../lib/schedule.js';
import Header from '../components/Header.jsx';
import NowBanner from '../components/NowBanner.jsx';
import StatsBar from '../components/StatsBar.jsx';
import WeekCalendar from '../components/WeekCalendar.jsx';
import AIAssistant from '../components/AIAssistant.jsx';
import InsightsPanel from '../components/InsightsPanel.jsx';
import UpcomingList from '../components/UpcomingList.jsx';
import BlockModal from '../components/BlockModal.jsx';
import SettingsModal from '../components/SettingsModal.jsx';
import ChatWidget from '../components/ChatWidget.jsx';

export default function Dashboard() {
  const { user } = useAuth();
  const toast = useToast();
  const [weekStart, setWeekStart] = useState(() => startOfWeek());
  const [blocks, setBlocks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null); // { block } | { defaults }
  const [showSettings, setShowSettings] = useState(false);
  const [health, setHealth] = useState(null);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    api.health().then(setHealth).catch(() => {});
    return () => clearInterval(t);
  }, []);

  const load = useCallback(async () => {
    const today = new Date();
    const from = addDays(weekStart < today ? weekStart : today, -1);
    const to = addDays(weekStart > today ? weekStart : today, 14);
    try {
      const { blocks } = await api.listBlocks(from.toISOString(), to.toISOString());
      setBlocks(blocks);
    } catch (err) {
      toast(err.message, { type: 'error' });
    } finally {
      setLoading(false);
    }
  }, [weekStart, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const live = useEvents({
    reminder: ({ message }) => {
      toast(message, { title: '⏰ Upcoming quiet time', duration: 10000 });
      notifyBrowser('Quiet time soon', message);
    },
    started: ({ message }) => {
      toast(message, { title: '🔕 Quiet mode on', type: 'success', duration: 10000 });
      notifyBrowser('Quiet mode on', message);
      setNow(new Date());
    },
    'blocks-changed': () => load(), // keeps multiple tabs/devices in sync
  });

  const stats = useMemo(() => weekStats(blocks, weekStart, now), [blocks, weekStart, now]);

  return (
    <div className="app">
      <Header user={user} live={live} ai={health?.ai} onSettings={() => setShowSettings(true)} />
      <main className="container">
        <NowBanner active={stats.active} now={now} />
        <StatsBar stats={stats} now={now} />

        <div className="layout">
          <section className="card calendar-card">
            <WeekCalendar
              weekStart={weekStart}
              blocks={blocks}
              now={now}
              loading={loading}
              onWeekChange={setWeekStart}
              onSelectBlock={(block) => setModal({ block })}
              onCreateAt={(start) => setModal({ defaults: { start } })}
            />
          </section>

          <aside className="sidebar">
            <AIAssistant onCreated={load} />
            <InsightsPanel blocks={blocks} onApplied={load} />
            <UpcomingList blocks={blocks} now={now} onSelect={(block) => setModal({ block })} />
          </aside>
        </div>
      </main>

      {modal && (
        <BlockModal
          {...modal}
          defaultReminder={user.preferences?.defaultReminderMinutes ?? 10}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            load();
          }}
        />
      )}
      {showSettings && <SettingsModal emailAvailable={health?.email} onClose={() => setShowSettings(false)} />}
      <ChatWidget userName={user.name} onScheduleChanged={load} />
    </div>
  );
}
