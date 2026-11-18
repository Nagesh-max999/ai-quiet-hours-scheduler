// Tiny JSON-file document store. Zero native dependencies so the project runs
// anywhere with `npm install`; all access goes through this module, so it can
// be swapped for MongoDB/Postgres without touching the routes.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function createStore(file) {
  const persist = file !== ':memory:';
  let state = { users: [], blocks: [] };

  if (persist && fs.existsSync(file)) {
    try {
      state = { users: [], blocks: [], ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (err) {
      console.error(`[db] Could not read ${file}, starting empty:`, err.message);
    }
  }

  function save() {
    if (!persist) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file); // atomic replace: never leaves a half-written file
  }

  return {
    // ---- users ----
    findUserByEmail: (email) => state.users.find((u) => u.email === email.toLowerCase()),
    findUserById: (id) => state.users.find((u) => u.id === id),
    createUser(data) {
      const user = { id: randomUUID(), createdAt: new Date().toISOString(), ...data, email: data.email.toLowerCase() };
      state.users.push(user);
      save();
      return user;
    },
    updateUser(id, patch) {
      const user = state.users.find((u) => u.id === id);
      if (!user) return null;
      Object.assign(user, patch);
      save();
      return user;
    },

    // ---- blocks ----
    listBlocks(userId, { from, to } = {}) {
      return state.blocks
        .filter((b) => b.userId === userId)
        .filter((b) => (!from || new Date(b.end) > new Date(from)) && (!to || new Date(b.start) < new Date(to)))
        .sort((a, b) => new Date(a.start) - new Date(b.start));
    },
    allBlocks: () => state.blocks,
    findBlock: (userId, id) => state.blocks.find((b) => b.id === id && b.userId === userId),
    createBlocks(userId, items, seriesId = null) {
      const now = new Date().toISOString();
      const created = items.map((item) => ({
        id: randomUUID(),
        userId,
        seriesId,
        reminderSentAt: null,
        startNotifiedAt: null,
        createdAt: now,
        ...item,
      }));
      state.blocks.push(...created);
      save();
      return created;
    },
    updateBlock(userId, id, patch) {
      const block = state.blocks.find((b) => b.id === id && b.userId === userId);
      if (!block) return null;
      Object.assign(block, patch, { updatedAt: new Date().toISOString() });
      save();
      return block;
    },
    deleteBlocks(userId, predicate) {
      const before = state.blocks.length;
      state.blocks = state.blocks.filter((b) => !(b.userId === userId && predicate(b)));
      const removed = before - state.blocks.length;
      if (removed) save();
      return removed;
    },
    /** Mark a block notification field; returns false if it was already set (dedupe). */
    claimNotification(id, field) {
      const block = state.blocks.find((b) => b.id === id);
      if (!block || block[field]) return false;
      block[field] = new Date().toISOString();
      save();
      return true;
    },
  };
}
