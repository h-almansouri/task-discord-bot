import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRulebook, verifyJoin, commonTrailingWords, familyLabel } from '../src/rulebook/build.mjs';

// Shaped like the real tables, trimmed to two travelers.
const npc_desc = [
  { npc_type: 6, name: 'Alesi', task_skill_check: [17] },
  { npc_type: 7, name: 'Ramparte', task_skill_check: [18] },
  { npc_type: 4, name: 'The Twins', task_skill_check: [] },
];

const item_desc = [
  { id: 1100007, name: 'Basic Embergrain', tier: 1, tag: 'Grain' },
  { id: 2100007, name: 'Simple Embergrain', tier: 2, tag: 'Grain' },
  { id: 767727086, name: 'Jakyl Fur', tier: -1, tag: 'Hide' },
];
const cargo_desc = [{ id: 1200, name: 'Rough Timber', tier: 1, tag: 'Timber' }];

const traveler_task_desc = [
  { id: 1, level_requirement: { skill_id: 17 }, required_items: [[1100007, 200, [0, []], [0, 0]]], description: 'Alesi wants grain.' },
  { id: 2, level_requirement: { skill_id: 17 }, required_items: [[2100007, 200, [0, []], [0, 0]]], description: 'Alesi wants more grain.' },
  // Same material at three quantities -> variable, needs an absolute threshold.
  { id: 3, level_requirement: [18, 1, 120], required_items: [[767727086, 1, [0, []], [0, 0]]], description: 'Ramparte wants fur.' },
  { id: 4, level_requirement: [18, 1, 120], required_items: [[767727086, 5, [0, []], [0, 0]]], description: 'Ramparte wants fur.' },
  { id: 5, level_requirement: [18, 1, 120], required_items: [[767727086, 10, [0, []], [0, 0]]], description: 'Ramparte wants fur.' },
  { id: 6, level_requirement: [18, 1, 120], required_items: [[1200, 1, [1, []], [1, []]]], description: 'Ramparte wants timber.' },
];

test('builds travelers from the skill join', () => {
  const rb = buildRulebook({ traveler_task_desc, npc_desc, item_desc, cargo_desc });
  assert.deepEqual(Object.keys(rb.travelers).sort(), ['Alesi', 'Ramparte']);
  assert.equal(rb.travelers.Alesi.taskCount, 2);
  assert.equal(rb.travelers.Ramparte.taskCount, 4);
});

test('a traveler with no task skills gives no tasks', () => {
  const rb = buildRulebook({ traveler_task_desc, npc_desc, item_desc, cargo_desc });
  assert.equal(rb.travelers['The Twins'], undefined);
});

test('handles named and positional level_requirement alike', () => {
  const rb = buildRulebook({ traveler_task_desc, npc_desc, item_desc, cargo_desc });
  assert.equal(rb.counts.tasksUnmapped, 0);
});

test('single-quantity materials are fixed and carry perTurnIn', () => {
  const rb = buildRulebook({ traveler_task_desc, npc_desc, item_desc, cargo_desc });
  const grain = rb.travelers.Alesi.materials.find((m) => m.key === 'item:1100007');
  assert.equal(grain.fixed, true);
  assert.equal(grain.perTurnIn, 200);
  assert.equal(grain.name, 'Basic Embergrain');
  assert.equal(grain.tag, 'Grain');
});

test('multi-quantity materials are variable with no perTurnIn', () => {
  const rb = buildRulebook({ traveler_task_desc, npc_desc, item_desc, cargo_desc });
  const fur = rb.travelers.Ramparte.materials.find((m) => m.key === 'item:767727086');
  assert.equal(fur.fixed, false);
  assert.equal(fur.perTurnIn, null);
  assert.deepEqual(fur.quantities, [1, 5, 10]);
  assert.equal(fur.taskCount, 3);
});

test('cargo requirements resolve against cargo_desc, not item_desc', () => {
  const rb = buildRulebook({ traveler_task_desc, npc_desc, item_desc, cargo_desc });
  const timber = rb.travelers.Ramparte.materials.find((m) => m.key === 'cargo:1200');
  assert.equal(timber.name, 'Rough Timber');
});

test('a skill claimed by two travelers is rejected rather than silently merged', () => {
  const clashing = [...npc_desc, { npc_type: 9, name: 'Impostor', task_skill_check: [17] }];
  assert.throws(() => buildRulebook({ traveler_task_desc, npc_desc: clashing, item_desc, cargo_desc }),
    /claimed by both/);
});

test('verifyJoin agrees with the traveler named in each description', () => {
  const r = verifyJoin(traveler_task_desc, npc_desc);
  assert.equal(r.mismatched, 0);
  assert.equal(r.unmapped, 0);
  assert.ok(r.checked > 0);
});

test('verifyJoin catches a join that contradicts the description', () => {
  const wrong = [{ id: 9, level_requirement: { skill_id: 17 }, required_items: [], description: 'Ramparte wants fur.' }];
  assert.equal(verifyJoin(wrong, npc_desc).mismatched, 1);
});

// --- family labels ---------------------------------------------------------

test('commonTrailingWords finds the shared ending of a family', () => {
  assert.equal(commonTrailingWords(['Basic Starbulb', 'Simple Starbulb', 'Fine Starbulb']), 'Starbulb');
  assert.equal(commonTrailingWords(['Rough Plant Fiber', 'Simple Plant Fiber']), 'Plant Fiber');
  assert.equal(commonTrailingWords(['Salt']), 'Salt');
});

test('commonTrailingWords returns nothing when names share no ending', () => {
  // Alesi's baitfish: no common substring at all.
  assert.equal(commonTrailingWords(['Briny Guppi', 'Azure Minni', 'Divine Tetra']), '');
  assert.equal(commonTrailingWords([]), '');
});

test('familyLabel prefers the real name over an internal tag', () => {
  assert.equal(familyLabel('Vegetable', ['Basic Starbulb', 'Fine Starbulb']), 'Starbulb');
  assert.equal(familyLabel('Grain', ['Basic Embergrain', 'Fine Embergrain']), 'Embergrain');
});

test('familyLabel keeps the tag when names share no ending', () => {
  assert.equal(familyLabel('Baitfish', ['Briny Guppi', 'Azure Minni']), 'Baitfish');
});

test('familyLabel does not trim a more specific tag down to a vaguer word', () => {
  // Members share only "Scale", but "Oceanfish Scale" says more, so the tag wins.
  assert.equal(
    familyLabel('Oceanfish Scale', ['Basic Oceanfish Scale', 'Crystalized Bass Scale']),
    'Oceanfish Scale',
  );
});

test('one tag covering several product lines is split by tier collision', () => {
  // Heimlich's shape: every material tagged "Basic Food", but five foods across
  // two tiers, so each tier holds five different items.
  const foods = [];
  const tasks = [];
  let id = 100;
  for (const dish of ['Cooked Berries', 'Mashed Bulbs', 'Mushroom Skewer']) {
    for (const [tier, prefix] of [[1, 'Plain'], [2, 'Savory']]) {
      foods.push({ id, name: `${prefix} ${dish}`, tier, tag: 'Basic Food' });
      tasks.push({
        id: id + 1000,
        level_requirement: { skill_id: 13 },
        required_items: [[id, 10, [0, []], [0, 0]]],
        description: 'Heimlich wants food.',
      });
      id++;
    }
  }
  const rb = buildRulebook({
    traveler_task_desc: tasks,
    npc_desc: [{ npc_type: 3, name: 'Heimlich', task_skill_check: [13] }],
    item_desc: foods,
    cargo_desc: [],
  });

  const families = new Set(rb.travelers.Heimlich.materials.map((m) => m.family));
  assert.deepEqual([...families].sort(), ['Cooked Berries', 'Mashed Bulbs', 'Mushroom Skewer']);

  // and no family may repeat a tier
  const byFamily = new Map();
  for (const m of rb.travelers.Heimlich.materials) {
    const list = byFamily.get(m.family) ?? [];
    byFamily.set(m.family, list);
    list.push(m.tier);
  }
  for (const [family, tiers] of byFamily) {
    assert.equal(tiers.length, new Set(tiers).size, `${family} repeats a tier`);
  }
});

test('a tag with one item per tier is left as a single family', () => {
  // Alesi's baitfish: ten different fish, one per tier, sharing no name. Splitting
  // these would make ten families of one.
  const fish = ['Briny Guppi', 'Muddy Guppi', 'Azure Minni', 'Divine Tetra'];
  const items = fish.map((name, i) => ({ id: 500 + i, name, tier: i + 1, tag: 'Baitfish' }));
  const tasks = items.map((it) => ({
    id: 9000 + it.id,
    level_requirement: { skill_id: 17 },
    required_items: [[it.id, 10, [0, []], [0, 0]]],
    description: 'Alesi wants bait.',
  }));
  const rb = buildRulebook({
    traveler_task_desc: tasks,
    npc_desc: [{ npc_type: 6, name: 'Alesi', task_skill_check: [17] }],
    item_desc: items,
    cargo_desc: [],
  });
  const families = new Set(rb.travelers.Alesi.materials.map((m) => m.family));
  assert.deepEqual([...families], ['Baitfish']);
});

test('currency is excluded — it is bought with, not stockpiled', () => {
  // One task in the whole catalogue requires Hex Coins: Rumbagh's mystery
  // shipment. It is a purchase, and coins live in the wallet.
  const rb = buildRulebook({
    traveler_task_desc: [{
      id: 1, level_requirement: { skill_id: 19 },
      required_items: [[1, 1000, [0, []], [0, 0]]],
      description: 'Rumbagh will give you a shipment in exchange for Hex Coins.',
    }],
    npc_desc: [{ npc_type: 1, name: 'Rumbagh', task_skill_check: [19] }],
    item_desc: [{ id: 1, name: 'Hex Coin', tier: -1, tag: 'Coins' }],
    cargo_desc: [],
  });
  assert.equal(rb.travelers.Rumbagh?.materials.length ?? 0, 0);
});

test('buildRulebook assigns a family label to every material', () => {
  const rb = buildRulebook({ traveler_task_desc, npc_desc, item_desc, cargo_desc });
  for (const traveler of Object.values(rb.travelers)) {
    for (const m of traveler.materials) {
      assert.ok(m.family, `${m.name} has no family label`);
    }
  }
  const grain = rb.travelers.Alesi.materials.find((m) => m.key === 'item:1100007');
  assert.equal(grain.family, 'Embergrain');   // from tag "Grain"
});
