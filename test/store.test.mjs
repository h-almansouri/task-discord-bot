import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultConfig, setStorageContainers, findStorage, countContainers, setTravelerTiers,
  loadGuildConfig, saveGuildConfig, updateGuildConfig, deleteGuildConfig,
} from '../src/config/store.mjs';

const SOURCE = { type: 'player', id: '1369094286781181638', name: 'Velcruza' };
const CONTAINERS = [
  { id: '111', name: 'Logs', origin: 'house' },
  { id: '222', name: 'Metal', origin: 'house' },
];

test('defaultConfig carries the documented shape', () => {
  const c = defaultConfig();
  assert.deepEqual(c.storages, []);
  assert.equal(c.turnIns, 5);
  assert.equal(c.reminder.hoursBefore, 24);
  assert.equal(c.channelId, null);
});

test('setStorageContainers adds a source', () => {
  const c = setStorageContainers(defaultConfig(), SOURCE, CONTAINERS);
  assert.equal(c.storages.length, 1);
  assert.equal(c.storages[0].source.name, 'Velcruza');
  assert.equal(c.storages[0].containers.length, 2);
});

test('setStorageContainers replaces rather than duplicating the same source', () => {
  let c = setStorageContainers(defaultConfig(), SOURCE, CONTAINERS);
  c = setStorageContainers(c, SOURCE, [CONTAINERS[0]]);
  assert.equal(c.storages.length, 1);
  assert.equal(c.storages[0].containers.length, 1);
});

test('selecting nothing drops the source instead of leaving a stub', () => {
  let c = setStorageContainers(defaultConfig(), SOURCE, CONTAINERS);
  c = setStorageContainers(c, SOURCE, []);
  assert.equal(c.storages.length, 0);
});

test('a player and a claim sharing an id are kept distinct', () => {
  const claim = { type: 'claim', id: SOURCE.id, name: 'Coincidence' };
  let c = setStorageContainers(defaultConfig(), SOURCE, CONTAINERS);
  c = setStorageContainers(c, claim, [{ id: '999', name: 'Bank', origin: 'claim' }]);
  assert.equal(c.storages.length, 2);
});

test('setStorageContainers stores only the fields config needs', () => {
  const fat = [{ id: '111', name: 'Logs', origin: 'house', pockets: [1, 2, 3], houseName: 'x' }];
  const c = setStorageContainers(defaultConfig(), SOURCE, fat);
  assert.deepEqual(c.storages[0].containers[0], { id: '111', name: 'Logs', origin: 'house' });
});

test('findStorage and countContainers agree with what was set', () => {
  const c = setStorageContainers(defaultConfig(), SOURCE, CONTAINERS);
  assert.equal(findStorage(c, SOURCE)?.containers.length, 2);
  assert.equal(findStorage(c, { type: 'claim', id: SOURCE.id }), undefined);
  assert.equal(countContainers(c), 2);
});

test('regression: changing tiers must not discard the rest of a traveler', () => {
  // Replacing the entry rather than merging silently dropped the traveler's
  // channel, the message being edited in place, and every ignored family.
  const before = {
    ...defaultConfig(),
    travelers: {
      Alesi: {
        tiers: [1, 10],
        channelId: '111',
        messageId: '222',
        excluded: ['Experimental Compounds'],
      },
    },
  };
  const after = setTravelerTiers(before, 'Alesi', [1, 5]);
  assert.deepEqual(after.travelers.Alesi.tiers, [1, 5]);
  assert.equal(after.travelers.Alesi.channelId, '111', 'the channel was lost');
  assert.equal(after.travelers.Alesi.messageId, '222', 'the message id was lost');
  assert.deepEqual(after.travelers.Alesi.excluded, ['Experimental Compounds'], 'exclusions were lost');
});

test('setTravelerTiers adds a traveler that was not there', () => {
  const after = setTravelerTiers(defaultConfig(), 'Svim', [1, 3]);
  assert.deepEqual(after.travelers.Svim, { tiers: [1, 3] });
});

test('setTravelerTiers leaves other travelers untouched', () => {
  const before = {
    ...defaultConfig(),
    travelers: { Alesi: { tiers: [1, 10] }, Svim: { tiers: [1, 3], channelId: '9' } },
  };
  const after = setTravelerTiers(before, 'Alesi', [1, 5]);
  assert.deepEqual(after.travelers.Svim, { tiers: [1, 3], channelId: '9' });
});

test('config round-trips through disk', async (t) => {
  const guildId = `test-${process.pid}`;
  t.after(() => deleteGuildConfig(guildId));

  assert.deepEqual((await loadGuildConfig(guildId)).storages, [], 'unknown guild should read as default');

  await saveGuildConfig(guildId, setStorageContainers(defaultConfig(), SOURCE, CONTAINERS));
  const loaded = await loadGuildConfig(guildId);
  assert.equal(loaded.storages[0].source.name, 'Velcruza');
  assert.equal(countContainers(loaded), 2);
});

test('concurrent updates are serialised, not lost', async (t) => {
  const guildId = `test-concurrent-${process.pid}`;
  t.after(() => deleteGuildConfig(guildId));

  // Fired together, as two Discord component interactions easily could be.
  await Promise.all([
    updateGuildConfig(guildId, (c) => setStorageContainers(c, SOURCE, CONTAINERS)),
    updateGuildConfig(guildId, (c) => setStorageContainers(
      c, { type: 'claim', id: '864691128488445884', name: 'Mystic Embassy' },
      [{ id: '333', name: 'Alesi Tasks', origin: 'claim' }],
    )),
  ]);

  const loaded = await loadGuildConfig(guildId);
  assert.equal(loaded.storages.length, 2, 'one update overwrote the other');
  assert.equal(countContainers(loaded), 3);
});

test('a partial config file is filled in with defaults', async (t) => {
  const guildId = `test-partial-${process.pid}`;
  t.after(() => deleteGuildConfig(guildId));

  await saveGuildConfig(guildId, { storages: [] });
  const loaded = await loadGuildConfig(guildId);
  assert.equal(loaded.turnIns, 5);
  assert.equal(loaded.reminder.hoursBefore, 24);
});
