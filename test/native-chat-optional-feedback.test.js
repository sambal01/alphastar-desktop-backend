const test = require('node:test'), assert = require('node:assert/strict');
const fixture = require('./helpers/native-feedback-fixture.cjs');
const { publicSummary } = require('../src/native-chat-lifecycle');

for (const source of ['website', 'mobile']) {
  test(source + ' may end with no rating, a comment only, or either rating; retries stay idempotent', async () => {
    for (const feedback of [{}, { rating: null, comment: '' }, { rating: '', comment: '  Synthetic comment only  ' }, { rating: 'up' }, { rating: 'down', comment: 'Synthetic note' }]) {
      const f = fixture(), chat = await f.open(source), body = { cycle: 1, ...feedback };
      const results = await Promise.all([chat.call('/end', body), chat.call('/end', body)]);
      for (const result of results) { assert.equal(result.code, 200); assert.equal(result.body.conversation.status, 'ended'); assert.equal(result.body.conversation.feedback, undefined); }
      const row = f.root.humanChats[chat.id], saved = publicSummary(row, { uid: 'staff' }).feedback;
      assert.equal(saved.rating, feedback.rating || null); assert.equal(saved.comment, (feedback.comment || '').trim());
      assert.equal(Object.values(f.root.nativeChatMessages[chat.id]).filter(message => /conversation has ended/i.test(message.text)).length, 1);
      assert.equal((await chat.call('/end', { cycle: 1, rating: feedback.rating === 'up' ? 'down' : 'up', comment: saved.comment })).code, 409);
      assert.equal((await chat.call('/messages', { cycle: 1, text: 'Too late', clientId: 'a'.repeat(32) })).code, 409);
    }
  });
  test(source + ' still validates feedback, ownership, and stale conversation cycles', async () => {
    const f = fixture(), chat = await f.open(source);
    for (const body of [{ cycle: 1, rating: 'invalid' }, { cycle: 1, rating: false }, { cycle: 1, comment: 'x'.repeat(1001) }, { cycle: 1, comment: {} }, { cycle: 1, comment: 12 }]) assert.equal((await chat.call('/end', body)).code, 400);
    assert.equal(f.root.humanChats[chat.id].status, 'waiting');
    assert.equal((await chat.call('/end', { cycle: 9 })).code, 409);
    assert.equal((await chat.call('/end', { cycle: 1 })).code, 200);
    if (source === 'mobile') {
      const resumed = await chat.call('/request', { cycle: 1 }); assert.equal(resumed.code, 200); assert.equal(resumed.body.conversation.cycle, 2);
      assert.equal((await chat.call('/end', { cycle: 1 })).code, 409); assert.equal(f.root.humanChats[chat.id].status, 'waiting');
    }
  });
}
