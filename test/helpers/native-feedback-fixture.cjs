const assert = require('node:assert/strict');
const { registerHumanChatRoutes } = require('../../src/human-chat');

module.exports = function fixture(options = {}) {
  const root = { users: { patient: { role: 'patient', fullName: 'Synthetic Patient', email: 'patient@example.test' } } }, handlers = new Map();
  const value = path => path ? path.split('/').reduce((row, key) => row?.[key], root) : root;
  const set = (path, row) => { const keys = path.split('/'), last = keys.pop(); let target = root; for (const key of keys) target = target[key] ||= {}; target[last] = structuredClone(row); };
  const snap = row => ({ val: () => row == null ? null : structuredClone(row) });
  const db = { ref(path = '') { let order = '', limit, before; return {
    on(_event, callback) { callback(snap(value(path))); }, off() {},
    orderByChild(key) { order = key; return this; }, limitToLast(count) { limit = count; return this; }, endBefore(time, key) { before = [time, key]; return this; },
    async get() {
      if (!order) return snap(value(path));
      let rows = Object.values(value(path) || {}).sort((a, b) => a[order].localeCompare(b[order]) || a.id.localeCompare(b.id));
      if (before) rows = rows.filter(row => row[order] < before[0] || row[order] === before[0] && row.id < before[1]);
      if (limit) rows = rows.slice(-limit);
      return snap(Object.fromEntries(rows.map(row => [row.id, row])));
    },
    async transaction(fn) { const next = fn(structuredClone(value(path) ?? null)); if (next !== undefined) set(path, next); return { committed: next !== undefined, snapshot: snap(value(path)) }; },
    async update(patch) { for (const [key, row] of Object.entries(patch)) set(path ? path + '/' + key : key, row); },
  }; } };
  registerHumanChatRoutes({ post(path, handler) { handlers.set('POST ' + path, handler); }, get(path, handler) { handlers.set('GET ' + path, handler); } }, {
    now: options.now || (() => Date.parse('2026-11-05T02:00:00Z')), getFirebaseApp: () => ({}), getDatabase: () => db,
    getAuth: () => ({ async verifyIdToken(token, revoked) { assert.equal(revoked, true); if (!root.users[token]) throw Error('Invalid token'); return { uid: token, email: root.users[token].email }; } }),
  });
  async function invoke(method, path, extra = {}) {
    const res = { code: 200, set() { return this; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handlers.get(method + ' ' + path)({ headers: {}, params: {}, query: {}, ip: 'synthetic-feedback', ...extra }, res); return res;
  }
  return { root, invoke, async open(source) {
    const mobile = source === 'mobile';
    const opened = await invoke('POST', mobile ? '/api/patient-support/chats/open' : '/api/support/chats', mobile ? { headers: { authorization: 'Bearer patient' } } : { body: { name: 'Synthetic Guest', email: 'guest@example.test', consent: true } });
    assert.equal(opened.code, 200);
    const { id, token } = opened.body, headers = mobile ? { authorization: 'Bearer patient' } : { 'x-alphastar-chat-token': token };
    const base = mobile ? '/api/patient-support/chats/:id' : '/api/support/chats/:id';
    const call = (suffix, body, method = 'POST') => invoke(method, base + suffix, { headers, params: { id }, ...(body ? { body } : {}) });
    assert.equal((await call('/request', { cycle: 1 })).code, 200);
    return { id, call };
  } };
};
