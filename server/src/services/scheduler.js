// Background job: every 30s, finds blocks whose reminder window has opened
// (or that just started) and notifies the owner exactly once per block.

import { localParts } from '../lib/time.js';
import { sendEmail, sendEvent } from './notifier.js';

const TICK_MS = 30_000;

export function runSchedulerTick(store, now = new Date()) {
  const fired = [];
  for (const block of store.allBlocks()) {
    const start = new Date(block.start);
    const end = new Date(block.end);
    const leadMs = block.reminderMinutes * 60_000;

    // 1) Upcoming reminder. claimNotification() marks the block before sending,
    //    so a block is never reminded twice, even if a tick overlaps.
    if (block.reminderMinutes > 0 && start > now && start - now <= leadMs && store.claimNotification(block.id, 'reminderSentAt')) {
      const minutes = Math.max(1, Math.round((start - now) / 60_000));
      notify(store, block, 'reminder', `"${block.title}" starts in ${minutes} min`);
      fired.push({ id: block.id, type: 'reminder' });
    }

    // 2) Block started -> quiet mode on.
    if (start <= now && end > now && store.claimNotification(block.id, 'startNotifiedAt')) {
      notify(store, block, 'started', `Quiet time: "${block.title}" has started`);
      fired.push({ id: block.id, type: 'started' });
    }
  }
  return fired;
}

function notify(store, block, type, message) {
  sendEvent(block.userId, type, { block: { id: block.id, title: block.title, category: block.category, start: block.start, end: block.end }, message });

  const user = store.findUserById(block.userId);
  if (type === 'reminder' && user?.preferences?.emailReminders) {
    const tz = user.preferences.timeZone || 'UTC';
    const s = localParts(block.start, tz);
    const e = localParts(block.end, tz);
    sendEmail({
      to: user.email,
      subject: `Reminder: ${block.title} starts soon`,
      text: `Hi ${user.name},\n\nYour quiet block "${block.title}" runs ${s.weekday} ${s.time}–${e.time} (${tz}).\nTime to wrap up and silence notifications.\n\n— Quiet Hours Scheduler`,
    }).catch((err) => console.warn('[email] failed:', err.message));
  }
}

export function startScheduler(store) {
  const timer = setInterval(() => {
    try {
      runSchedulerTick(store);
    } catch (err) {
      console.error('[scheduler] tick failed:', err);
    }
  }, TICK_MS);
  timer.unref();
  runSchedulerTick(store);
  return () => clearInterval(timer);
}
