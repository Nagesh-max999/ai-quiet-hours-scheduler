// Offline chatbot used when Claude isn't configured (or a Claude call fails).
// Detects a few intents: help, "what's next", insights, and scheduling requests.

import { parseSchedule } from './heuristicParser.js';
import { heuristicInsights } from './insights.js';

const HELP =
  "I'm your quiet-hours assistant. I can:\n" +
  '- **Plan blocks**: "study 7-9pm on weekdays" or "sleep 11pm-7am every night"\n' +
  '- **Show your schedule**: "what\'s coming up?" or "what do I have tomorrow?"\n' +
  '- **Coach you**: "how is my week looking?" or "any tips?"';

/**
 * @param {string} text latest user message
 * @param {{ today, weekday, nowTime, weekSummary }} ctx
 * @returns {{ reply: string, proposals: object[] }}
 */
export function heuristicChat(text, ctx) {
  const t = String(text).toLowerCase().trim();

  if (/^(hi|hello|hey|yo|help|what can you do|\?)\b/.test(t) || t.length < 3) {
    return { reply: `Hi! ${HELP}`, proposals: [] };
  }

  if (/\b(score|insight|tips?|advice|improve|better|healthy|how('s| is) my|how am i|review|analy[sz]e)\b/.test(t)) {
    const ins = heuristicInsights(ctx.weekSummary);
    const lines = ins.suggestions.slice(0, 3).map((s) => `- **${s.title}**: ${s.detail}`);
    return {
      reply: `Your quiet-time score is **${ins.score}/100**. ${ins.headline}\n${lines.join('\n')}`,
      proposals: ins.suggestions.map((s) => s.proposal).filter(Boolean).slice(0, 2),
    };
  }

  const hasTime = /\d/.test(t);
  if (!hasTime && /\b(next|upcoming|coming up|today|tonight|tomorrow|schedule|agenda|planned|what do i have|this week)\b/.test(t)) {
    return { reply: describeSchedule(t, ctx), proposals: [] };
  }

  const parsed = parseSchedule(text, ctx);
  if (parsed.proposals.length) {
    return {
      reply: `Here's what I'd add. Review the ${parsed.proposals.length > 1 ? 'blocks' : 'block'} below and tap **Add to calendar** to confirm.`,
      proposals: parsed.proposals,
    };
  }

  return { reply: `I'm not sure how to help with that yet. ${HELP}`, proposals: [] };
}

function describeSchedule(t, { weekSummary }) {
  let days = weekSummary.days;
  let label = 'the next 7 days';
  if (/\btoday|tonight\b/.test(t)) [days, label] = [days.slice(0, 1), 'today'];
  else if (/\btomorrow\b/.test(t)) [days, label] = [days.slice(1, 2), 'tomorrow'];

  const withBlocks = days.filter((d) => d.blocks.length);
  if (!withBlocks.length) return `You have nothing scheduled for ${label}. Want me to plan something? Try "deep work 9-11am tomorrow".`;
  const lines = withBlocks.map(
    (d) => `**${d.weekday}**: ${d.blocks.map((b) => `${b.title} ${b.start}–${b.end}${b.endsNextDay ? ' (+1)' : ''}`).join(', ')}`,
  );
  return `Here's ${label}:\n${lines.map((l) => `- ${l}`).join('\n')}`;
}
