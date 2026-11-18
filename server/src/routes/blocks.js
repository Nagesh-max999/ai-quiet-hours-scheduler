import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { findConflicts, validateBlock } from '../lib/blocks.js';
import { sendEvent } from '../services/notifier.js';

const MAX_BATCH = 120;

export function blockRoutes(store) {
  const r = Router();

  r.get('/', (req, res) => {
    const { from, to } = req.query;
    res.json({ blocks: store.listBlocks(req.user.id, { from, to }) });
  });

  // Create one block ({...}) or many ({ blocks: [...], skipConflicts }).
  r.post('/', (req, res) => {
    const isBatch = Array.isArray(req.body?.blocks);
    const raw = isBatch ? req.body.blocks : [req.body];
    if (raw.length === 0) return res.status(400).json({ error: 'No blocks to create' });
    if (raw.length > MAX_BATCH) return res.status(400).json({ error: `At most ${MAX_BATCH} blocks per request` });

    const valid = [];
    for (const [i, item] of raw.entries()) {
      const { value, error } = validateBlock(item);
      if (error) return res.status(400).json({ error: isBatch ? `Block ${i + 1}: ${error}` : error });
      valid.push(value);
    }

    const conflicts = findConflicts(valid, store.listBlocks(req.user.id));
    if (conflicts.length && !req.body.skipConflicts) {
      return res.status(409).json({ error: 'Some blocks overlap with your existing schedule', conflicts });
    }
    const skip = new Set(conflicts.map((c) => c.index));
    if (skip.size === valid.length) return res.status(409).json({ error: 'Every block overlaps an existing one', conflicts });

    // Items sharing a `group` key (e.g. one AI proposal) become one series,
    // so the user can later delete "this and following" in one click.
    const groups = new Map();
    valid.forEach((block, i) => {
      if (skip.has(i)) return;
      const key = isBatch ? String(raw[i].group ?? 'batch') : `single-${i}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(block);
    });
    const created = [];
    for (const items of groups.values()) {
      created.push(...store.createBlocks(req.user.id, items, items.length > 1 ? randomUUID() : null));
    }
    sendEvent(req.user.id, 'blocks-changed', {});
    res.status(201).json({ blocks: created, skipped: conflicts });
  });

  r.put('/:id', (req, res) => {
    const existing = store.findBlock(req.user.id, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Block not found' });
    const { value, error } = validateBlock({ ...existing, ...req.body });
    if (error) return res.status(400).json({ error });

    const conflicts = findConflicts([value], store.listBlocks(req.user.id), { ignoreId: existing.id });
    if (conflicts.length) return res.status(409).json({ error: 'This change overlaps another block', conflicts });

    const timeChanged = value.start !== existing.start || value.reminderMinutes !== existing.reminderMinutes;
    const patch = { ...value, source: existing.source };
    if (timeChanged) Object.assign(patch, { reminderSentAt: null, startNotifiedAt: null }); // re-arm reminders
    const block = store.updateBlock(req.user.id, existing.id, patch);
    sendEvent(req.user.id, 'blocks-changed', {});
    res.json({ block });
  });

  // DELETE /:id            -> one block
  // DELETE /:id?series=1   -> this and all future blocks in its series
  r.delete('/:id', (req, res) => {
    const block = store.findBlock(req.user.id, req.params.id);
    if (!block) return res.status(404).json({ error: 'Block not found' });
    const wholeSeries = req.query.series && block.seriesId;
    const removed = store.deleteBlocks(req.user.id, (b) =>
      wholeSeries ? b.seriesId === block.seriesId && new Date(b.start) >= new Date(block.start) : b.id === block.id,
    );
    sendEvent(req.user.id, 'blocks-changed', {});
    res.json({ removed });
  });

  return r;
}
