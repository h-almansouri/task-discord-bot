import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRow, toNamed } from '../src/relay/decode.mjs';
import {
  microsFromScheduledAt, rotationFromRows, sanitizeHours, shouldAnnounce, renderReminder,
} from '../src/reminder/rotation.mjs';
import { announceForGuild } from '../src/reminder/poll.mjs';
import {
  defaultConfig, saveGuildConfig, loadGuildConfig, deleteGuildConfig,
} from '../src/config/store.mjs';

// Real values read from both relays on 2026-08-22. The timestamp decodes to
// 2026-08-27T14:46:21.396Z — exactly 604,800s after the design-time sample,
// which is what confirms the weekly cadence.
const COLUMNS = ['scheduled_id', 'scheduled_at'];
const MICROS = '1787841981396070';
const AT_MS = 1787841981396;
const BITJITA_RAW = '[49155,[1,[1787841981396070]]]';
const BITCRAFTSYNC_RAW =
  '{"scheduled_id":49155,"scheduled_at":[1,{"__timestamp_micros_since_unix_epoch__":1787841981396070}]}';

// --- parsing the timer row --------------------------------------------------
// A wrong parse here never errors — the reminder just never fires. These run
// the full pipeline (parseRow -> toNamed -> micros) on the real raw strings.

test('the bitjita (positional) timer row parses to the exact micros string', () => {
  const named = toNamed(parseRow(BITJITA_RAW), COLUMNS);
  assert.equal(microsFromScheduledAt(named.scheduled_at), MICROS);
});

test('the bitcraftsync (named) timer row parses to the exact micros string', () => {
  const named = toNamed(parseRow(BITCRAFTSYNC_RAW), COLUMNS);
  assert.equal(microsFromScheduledAt(named.scheduled_at), MICROS);
});

test('an interval-scheduled timer (tag 0) yields null rather than a guessed time', () => {
  assert.equal(microsFromScheduledAt([0, ['604800000000']]), null);
});

test('garbage scheduled_at shapes yield null, not NaN or a truthy wreck', () => {
  for (const bad of [null, undefined, 42, 'soon', [], [1], [1, []], [1, {}], [1, [null]], [1, ['later']]]) {
    assert.equal(microsFromScheduledAt(bad), null, JSON.stringify(bad));
  }
});

test('a numeric payload is tolerated, since small values escape the big-int quoting', () => {
  assert.equal(microsFromScheduledAt([1, [1234567]]), '1234567');
});

test('rotationFromRows converts micros to exact milliseconds', () => {
  const rotation = rotationFromRows([toNamed(parseRow(BITJITA_RAW), COLUMNS)]);
  assert.equal(rotation.micros, MICROS);
  assert.equal(rotation.atMs, AT_MS);
});

test('rotationFromRows survives empty and junk row sets', () => {
  assert.equal(rotationFromRows([]), null);
  assert.equal(rotationFromRows(undefined), null);
  assert.equal(rotationFromRows([{ scheduled_id: 1 }, { scheduled_at: 'nope' }]), null);
});

test('with several rows the freshest schedule wins', () => {
  const rotation = rotationFromRows([
    { scheduled_at: [1, ['1787237181395131']] },   // the older, design-time reading
    { scheduled_at: [1, [MICROS]] },
  ]);
  assert.equal(rotation.micros, MICROS);
});

// --- the window decision ----------------------------------------------------

const HOUR = 3_600_000;
const rotation = { micros: MICROS, atMs: AT_MS };
const reminder = (over = {}) => ({ roleId: 'r1', hoursBefore: 24, channelId: null, announcedFor: null, ...over });

test('sanitizeHours falls back to 24 for anything unusable', () => {
  for (const bad of [0, -3, NaN, undefined, null, Infinity]) assert.equal(sanitizeHours(bad), 24);
  assert.equal(sanitizeHours(48), 48);
});

test('no configured role means no ping, whatever the clock says', () => {
  const d = shouldAnnounce({ rotation, reminder: reminder({ roleId: null }), nowMs: AT_MS - HOUR });
  assert.deepEqual(d, { announce: false, reason: 'no-role' });
});

test('no known rotation means no ping', () => {
  const d = shouldAnnounce({ rotation: null, reminder: reminder(), nowMs: AT_MS - HOUR });
  assert.deepEqual(d, { announce: false, reason: 'no-rotation' });
});

test('before the window opens: quiet', () => {
  const d = shouldAnnounce({ rotation, reminder: reminder(), nowMs: AT_MS - 25 * HOUR });
  assert.deepEqual(d, { announce: false, reason: 'before-window' });
});

test('the moment the window opens: ping', () => {
  const d = shouldAnnounce({ rotation, reminder: reminder(), nowMs: AT_MS - 24 * HOUR });
  assert.deepEqual(d, { announce: true, reason: 'window' });
});

test('a rotation already announced stays announced', () => {
  const d = shouldAnnounce({ rotation, reminder: reminder({ announcedFor: MICROS }), nowMs: AT_MS - HOUR });
  assert.deepEqual(d, { announce: false, reason: 'already-announced' });
});

test('a *different* announced rotation does not suppress this one', () => {
  const d = shouldAnnounce({ rotation, reminder: reminder({ announcedFor: '1787237181395131' }), nowMs: AT_MS - HOUR });
  assert.equal(d.announce, true);
});

test('once the reroll moment arrives, the window is over', () => {
  for (const nowMs of [AT_MS, AT_MS + HOUR]) {
    const d = shouldAnnounce({ rotation, reminder: reminder(), nowMs });
    assert.deepEqual(d, { announce: false, reason: 'rotation-passed' });
  }
});

test('an unusable hoursBefore behaves as the 24h default rather than never firing', () => {
  const d = shouldAnnounce({ rotation, reminder: reminder({ hoursBefore: 0 }), nowMs: AT_MS - 23 * HOUR });
  assert.equal(d.announce, true);
});

// --- the message ------------------------------------------------------------

test('the ping mentions the role and uses Discord-native timestamps', () => {
  const payload = renderReminder(rotation, reminder());
  assert.match(payload.content, /<@&r1>/);
  assert.match(payload.content, /<t:1787841981:R>/);
  assert.match(payload.content, /<t:1787841981:F>/);
});

test('allowedMentions is restricted to exactly the configured role', () => {
  const payload = renderReminder(rotation, reminder());
  assert.deepEqual(payload.allowedMentions, { roles: ['r1'] });
});

// --- announceForGuild: send, persist, retry ---------------------------------

function fakeClient(channel) {
  const fetched = [];
  return {
    fetched,
    channels: { fetch: async (id) => { fetched.push(id); return channel; } },
  };
}

function fakeChannel({ fail = false } = {}) {
  const sends = [];
  return {
    sends,
    isTextBased: () => true,
    send: async (payload) => {
      if (fail) throw new Error('boom');
      sends.push(payload);
      return { id: 'm1' };
    },
  };
}

const inWindow = { nowMs: AT_MS - HOUR };

test('a successful ping is persisted so it cannot repeat', async (t) => {
  const guildId = `test-reminder-ok-${process.pid}`;
  t.after(() => deleteGuildConfig(guildId));
  await saveGuildConfig(guildId, {
    ...defaultConfig(),
    channelId: 'c1',
    reminder: { roleId: 'r1', hoursBefore: 24, channelId: null, announcedFor: null },
  });

  const channel = fakeChannel();
  const client = fakeClient(channel);

  const first = await announceForGuild(client, guildId, rotation, inWindow);
  assert.equal(first.status, 'announced');
  assert.equal(channel.sends.length, 1);
  assert.match(channel.sends[0].content, /<@&r1>/);
  assert.equal((await loadGuildConfig(guildId)).reminder.announcedFor, MICROS);

  const second = await announceForGuild(client, guildId, rotation, inWindow);
  assert.equal(second.status, 'already-announced');
  assert.equal(channel.sends.length, 1, 'the ping went out twice');
});

test('a failed send is NOT persisted, so the next check retries it', async (t) => {
  const guildId = `test-reminder-fail-${process.pid}`;
  t.after(() => deleteGuildConfig(guildId));
  await saveGuildConfig(guildId, {
    ...defaultConfig(),
    channelId: 'c1',
    reminder: { roleId: 'r1', hoursBefore: 24, channelId: null, announcedFor: null },
  });

  const r = await announceForGuild(fakeClient(fakeChannel({ fail: true })), guildId, rotation, inWindow);
  assert.equal(r.status, 'send-failed');
  assert.equal((await loadGuildConfig(guildId)).reminder.announcedFor, null, 'a failed ping was marked announced');
});

test('the reminder channel wins over the guild default when both are set', async (t) => {
  const guildId = `test-reminder-chan-${process.pid}`;
  t.after(() => deleteGuildConfig(guildId));
  await saveGuildConfig(guildId, {
    ...defaultConfig(),
    channelId: 'default-chan',
    reminder: { roleId: 'r1', hoursBefore: 24, channelId: 'reminder-chan', announcedFor: null },
  });

  const client = fakeClient(fakeChannel());
  await announceForGuild(client, guildId, rotation, inWindow);
  assert.deepEqual(client.fetched, ['reminder-chan']);
});

test('no channel anywhere reports no-channel rather than throwing', async (t) => {
  const guildId = `test-reminder-nochan-${process.pid}`;
  t.after(() => deleteGuildConfig(guildId));
  await saveGuildConfig(guildId, {
    ...defaultConfig(),
    reminder: { roleId: 'r1', hoursBefore: 24, channelId: null, announcedFor: null },
  });

  const r = await announceForGuild(fakeClient(fakeChannel()), guildId, rotation, inWindow);
  assert.equal(r.status, 'no-channel');
});

test('a config written before the reminder fields existed still pings', async (t) => {
  // Guilds configured by earlier versions have reminder: {roleId, hoursBefore}
  // only. Missing announcedFor/channelId must read as "never announced".
  const guildId = `test-reminder-legacy-${process.pid}`;
  t.after(() => deleteGuildConfig(guildId));
  await saveGuildConfig(guildId, {
    ...defaultConfig(),
    channelId: 'c1',
    reminder: { roleId: 'r1', hoursBefore: 24 },
  });

  const channel = fakeChannel();
  const r = await announceForGuild(fakeClient(channel), guildId, rotation, inWindow);
  assert.equal(r.status, 'announced');
  assert.equal(channel.sends.length, 1);
});

test('defaultConfig carries the reminder persistence fields', () => {
  const c = defaultConfig();
  assert.equal(c.reminder.channelId, null);
  assert.equal(c.reminder.announcedFor, null);
});
