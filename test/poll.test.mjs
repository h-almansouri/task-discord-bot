import test from 'node:test';
import assert from 'node:assert/strict';
import { runOnce } from '../src/tracker/poll.mjs';
import { loadRulebook } from '../src/rulebook/load.mjs';
import {
  defaultConfig, saveGuildConfig, loadGuildConfig, deleteGuildConfig,
} from '../src/config/store.mjs';

const rulebook = await loadRulebook();

/**
 * A channel whose messages behave like Discord's: fetch of an unknown id
 * throws code 10008, sends can be slowed to widen race windows, and a
 * transient failure can be injected on fetch.
 */
function fakeChannel() {
  const channel = {
    sent: [],
    store: new Map(),
    fetchError: null,
    counter: 0,
    isTextBased: () => true,
    send: async (payload) => {
      await new Promise((r) => setTimeout(r, 10));
      const id = `m${++channel.counter}`;
      const msg = { id, edits: [], edit: async (p) => { msg.edits.push(p); return msg; } };
      channel.store.set(id, msg);
      channel.sent.push(payload);
      return msg;
    },
    messages: {
      fetch: async (id) => {
        if (channel.fetchError) throw channel.fetchError;
        const m = channel.store.get(id);
        if (!m) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
        return m;
      },
    },
  };
  return channel;
}

const clientFor = (channel) => ({ channels: { fetch: async () => channel } });

/** A guild tracking Ramparte with no storages: zero stock, no network. */
async function seed(guildId, extra = {}) {
  await saveGuildConfig(guildId, {
    ...defaultConfig(),
    channelId: 'c1',
    travelers: { Ramparte: {} },
    variableDefault: 5,
    ...extra,
  });
}

test('regression: two concurrent passes cannot double-post a tracker message', async (t) => {
  // A slash command's forced pass racing the 20s timer pass both saw
  // messageId null and both posted — the duplicate frozen-tracker bug.
  const guildId = `test-race-${process.pid}`;
  t.after(() => deleteGuildConfig(guildId));
  await seed(guildId);

  const channel = fakeChannel();
  const client = clientFor(channel);
  await Promise.all([
    runOnce(client, guildId, { rulebook, force: true }),
    runOnce(client, guildId, { rulebook, force: true }),
  ]);

  assert.equal(channel.sent.length, 1, 'both passes posted a message');
  const config = await loadGuildConfig(guildId);
  assert.equal(config.travelers.Ramparte.messageId, 'm1');
  assert.equal(channel.store.get('m1').edits.length, 1, 'the second pass should edit, not post');
});

test('regression: a transient failure keeps the message id rather than replacing it', async (t) => {
  // Any hiccup — rate limit, outage, missing permission — used to fall through
  // to send(), permanently orphaning the tracked message at its last numbers.
  const guildId = `test-transient-${process.pid}`;
  t.after(() => deleteGuildConfig(guildId));
  await seed(guildId, { travelers: { Ramparte: { messageId: 'm-live' } } });

  const channel = fakeChannel();
  channel.store.set('m-live', { id: 'm-live', edits: [], edit: async () => { throw new Error('nope'); } });
  channel.fetchError = Object.assign(new Error('You are being rate limited'), { status: 429 });

  const r = await runOnce(clientFor(channel), guildId, { rulebook, force: true });
  assert.equal(channel.sent.length, 0, 'a transient failure must never post a duplicate');
  assert.deepEqual(r.problems, ['Ramparte: edit-failed']);
  assert.equal((await loadGuildConfig(guildId)).travelers.Ramparte.messageId, 'm-live', 'the id was dropped');
});

test('a transient failure on edit itself also keeps the id', async (t) => {
  const guildId = `test-editfail-${process.pid}`;
  t.after(() => deleteGuildConfig(guildId));
  await seed(guildId, { travelers: { Ramparte: { messageId: 'm-live' } } });

  const channel = fakeChannel();
  channel.store.set('m-live', {
    id: 'm-live',
    edit: async () => { throw Object.assign(new Error('Missing Permissions'), { code: 50013 }); },
  });

  const r = await runOnce(clientFor(channel), guildId, { rulebook, force: true });
  assert.equal(channel.sent.length, 0);
  assert.deepEqual(r.problems, ['Ramparte: edit-failed']);
});

test('a message that is confirmed gone is replaced', async (t) => {
  // fetch throws 10008 Unknown Message — someone deleted the tracker. This is
  // the one case where posting anew is right.
  const guildId = `test-gone-${process.pid}`;
  t.after(() => deleteGuildConfig(guildId));
  await seed(guildId, { travelers: { Ramparte: { messageId: 'm-deleted' } } });

  const channel = fakeChannel();
  const r = await runOnce(clientFor(channel), guildId, { rulebook, force: true });
  assert.equal(r.status, 'ok');
  assert.equal(channel.sent.length, 1);
  assert.equal((await loadGuildConfig(guildId)).travelers.Ramparte.messageId, 'm1');
});
