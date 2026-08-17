import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRulebook, findTraveler, groupByTag } from '../src/rulebook/load.mjs';
import { buildCommands } from '../src/commands.mjs';

// Runs against the committed rulebook, so it also guards that file's shape.
const rulebook = await loadRulebook();

test('the committed rulebook has the expected content', () => {
  assert.equal(rulebook.counts.tasks, 321);
  assert.equal(rulebook.counts.tasksUnmapped, 0);
  assert.equal(rulebook.counts.travelers, 6);
  assert.ok(rulebook.travelers.Alesi, 'Alesi should be present');
});

test('Alesi has 5 material families across 10 tiers', () => {
  const groups = groupByTag(rulebook.travelers.Alesi.materials);
  assert.equal(groups.length, 5);
  for (const [, mats] of groups) assert.equal(mats.length, 10);
  assert.deepEqual(
    groups.map(([tag]) => tag).sort(),
    ['Baitfish', 'Grain', 'Healing Potion', 'Plant Fiber', 'Vegetable'],
  );
});

test('Baitfish groups items that share no common substring', () => {
  const groups = new Map(groupByTag(rulebook.travelers.Alesi.materials));
  const names = groups.get('Baitfish').map((m) => m.name);
  assert.ok(names.includes('Briny Guppi'));
  assert.ok(names.includes('Azure Minni'));
  assert.ok(names.includes('Divine Tetra'));
});

test('exactly 8 materials across all travelers need a manual threshold', () => {
  const variable = Object.values(rulebook.travelers)
    .flatMap((t) => t.materials.filter((m) => !m.fixed));
  assert.equal(variable.length, 8);
});

test('Svim\'s Salt is the one variable material outside Ramparte', () => {
  const salt = rulebook.travelers.Svim.materials.find((m) => !m.fixed);
  assert.equal(salt.name, 'Salt');
  assert.ok(salt.quantities.length > 1);
  assert.equal(salt.perTurnIn, null);
});

test('findTraveler is case-insensitive', () => {
  assert.equal(findTraveler(rulebook, 'alesi')?.name, 'Alesi');
  assert.equal(findTraveler(rulebook, 'ALESI')?.name, 'Alesi');
  assert.equal(findTraveler(rulebook, 'nobody'), null);
});

test('every command passes discord.js validation', () => {
  const commands = buildCommands(rulebook);
  assert.ok(commands.length >= 3);
  for (const c of commands) {
    const json = c.data.toJSON();          // throws if the builder is invalid
    assert.match(json.name, /^[\w-]{1,32}$/);
    assert.ok(json.description.length > 0 && json.description.length <= 100);
    assert.equal(typeof c.run, 'function');
  }
});

test('the traveler choice list stays inside Discord\'s 25-option cap', () => {
  const traveler = buildCommands(rulebook).find((c) => c.data.name === 'traveler');
  const choices = traveler.data.toJSON().options[0].choices;
  assert.ok(choices.length <= 25, `${choices.length} choices exceeds the cap`);
  assert.equal(choices.length, 6);
});
