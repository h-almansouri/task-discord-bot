import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRulebook, findTraveler, groupByTag } from '../src/rulebook/load.mjs';
import { buildCommands } from '../src/commands/index.mjs';

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

/** Every option carrying choices, at any nesting depth. */
function allChoiceOptions(json) {
  const found = [];
  const walk = (options, path) => {
    for (const o of options ?? []) {
      const here = `${path} ${o.name}`;
      if (o.choices) found.push({ path: here, choices: o.choices });
      walk(o.options, here);
    }
  };
  walk(json.options, `/${json.name}`);
  return found;
}

test('no choice list anywhere exceeds Discord\'s 25-option cap', () => {
  const lists = buildCommands(rulebook).flatMap((c) => allChoiceOptions(c.data.toJSON()));
  assert.ok(lists.length > 0, 'expected at least one choice list to check');
  for (const { path, choices } of lists) {
    assert.ok(choices.length <= 25, `${path} has ${choices.length} choices, over the cap`);
  }
});

test('every /traveler traveler picker uses autocomplete, not fixed choices', () => {
  // The useful list differs per guild — untracked for add, tracked for the rest —
  // and registered choices are identical for every server.
  const traveler = buildCommands(rulebook).find((c) => c.data.name === 'traveler');
  assert.equal(allChoiceOptions(traveler.data.toJSON()).length, 0, 'no fixed choices should remain');

  for (const sub of traveler.data.toJSON().options) {
    const picker = sub.options?.find((o) => o.name === 'name' || o.name === 'traveler');
    if (!picker) continue;
    assert.equal(picker.autocomplete, true, `/traveler ${sub.name} should autocomplete`);
  }
  assert.equal(typeof traveler.autocomplete, 'function', 'the command needs an autocomplete handler');
});

test('the expected commands are registered', () => {
  const names = buildCommands(rulebook).map((c) => c.data.name).sort();
  assert.deepEqual(names, ['config', 'ping', 'refresh', 'setup', 'storage', 'traveler']);
});

test('/traveler exposes add and update as separate subcommands', () => {
  const traveler = buildCommands(rulebook).find((c) => c.data.name === 'traveler');
  const subs = traveler.data.toJSON().options.map((o) => o.name).sort();
  assert.deepEqual(subs, ['add', 'ignore', 'list', 'remove', 'unignore', 'update']);
});
