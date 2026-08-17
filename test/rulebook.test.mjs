import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRulebook, verifyJoin } from '../src/rulebook/build.mjs';

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
