import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEnvelope, parseRow, columnsOf, toNamed, rowsFromSnapshot,
  skillIdOf, requirementsOf,
} from '../src/relay/decode.mjs';

// Task 1805868417 as served by each relay — same data, different encoding.
const NAMED_ROW = '{"id":1805868417,"level_requirement":{"skill_id":15,"min_level":1,"max_level":120},"required_items":[[1200,1,[1,[]],[1,[]]]],"rewarded_items":[[1,100,[0,[]],[0,0]]],"rewarded_experience":{"skill_id":15,"quantity":1000.0},"description":"Brico needs some Timber for a building project he\'s working on."}';
const POSITIONAL_ROW = '[1805868417,[15,1,120],[[1200,1,[1,[]],[1,[]]]],[[1,100,[0,[]],[0,0]]],[15,1000.0],"Brico needs some Timber for a building project he\'s working on."]';

const TASK_COLUMNS = ['id', 'level_requirement', 'required_items', 'rewarded_items', 'rewarded_experience', 'description'];

const SCHEMA = {
  tables: [{ name: 'traveler_task_desc', product_type_ref: 0 }],
  typespace: { types: [{ Product: { elements: TASK_COLUMNS.map((c) => ({ name: { some: c } })) } }] },
};

// A real timer snapshot: the row is a JSON *string* holding a 16-digit integer.
const TIMER_ENVELOPE = '{"InitialSubscription":{"database_update":{"tables":[{"table_id":4557,"table_name":"traveler_task_loop_timer","num_rows":1,"updates":[{"deletes":[],"inserts":["[49154,[1,[1787237181395131]]]"]}]}]},"request_id":1}}';

test('parseEnvelope leaves the envelope intact', () => {
  const msg = parseEnvelope(TIMER_ENVELOPE);
  assert.equal(msg.InitialSubscription.database_update.tables[0].table_name, 'traveler_task_loop_timer');
});

test('regression: the big-int regex must NOT be applied to the whole message', () => {
  // This is the bug the design doc calls out (§4.5). Substituting over the
  // envelope injects quotes inside a string literal and corrupts it.
  const mangled = TIMER_ENVELOPE.replace(/([\[,:])\s*(-?\d{16,})/g, '$1"$2"');
  assert.throws(() => JSON.parse(mangled), SyntaxError,
    'expected whole-message substitution to produce invalid JSON');
  // The correct order parses cleanly.
  assert.doesNotThrow(() => parseEnvelope(TIMER_ENVELOPE));
});

test('parseRow quotes 16+ digit integers as strings', () => {
  const row = parseRow('[49154,[1,[1787237181395131]]]');
  assert.equal(row[1][1][0], '1787237181395131');
  // Note this particular value is only 16 digits (~1.79e15) and so is still
  // below MAX_SAFE_INTEGER — quoting it is conservative, not corrective.
  assert.ok(1787237181395131 < Number.MAX_SAFE_INTEGER);
});

test('parseRow prevents real precision loss on 19-digit entity ids', () => {
  const row = parseRow('[1369094286781181638,"Velcruza"]');
  assert.equal(row[0], '1369094286781181638');
  // This is the case that actually breaks: a naive parse silently rounds it.
  assert.notEqual(String(JSON.parse('[1369094286781181638]')[0]), '1369094286781181638');
  assert.ok(1369094286781181638 > Number.MAX_SAFE_INTEGER);
});

test('columnsOf reads positional column order from a schema', () => {
  assert.deepEqual(columnsOf(SCHEMA, 'traveler_task_desc'), TASK_COLUMNS);
});

test('columnsOf fails loudly on an unknown table', () => {
  assert.throws(() => columnsOf(SCHEMA, 'nope'), /table not in schema/);
});

test('both relay encodings yield the same task', () => {
  const named = parseRow(NAMED_ROW);
  const positional = toNamed(parseRow(POSITIONAL_ROW), TASK_COLUMNS);

  assert.equal(named.id, positional.id);
  assert.equal(named.description, positional.description);
  assert.equal(skillIdOf(named), 15);
  assert.equal(skillIdOf(positional), 15);
  assert.deepEqual(requirementsOf(named), requirementsOf(positional));
});

test('toNamed passes already-named rows through untouched', () => {
  const named = parseRow(NAMED_ROW);
  assert.equal(toNamed(named, TASK_COLUMNS), named);
});

test('requirementsOf flattens the positional requirement tuple', () => {
  assert.deepEqual(requirementsOf(parseRow(NAMED_ROW)), [
    { itemId: '1200', quantity: 1, itemType: 'cargo' },
  ]);
});

test('requirementsOf reads type tag 0 as item', () => {
  const task = { required_items: [[1100007, 200, [0, []], [0, 0]]] };
  assert.deepEqual(requirementsOf(task), [
    { itemId: '1100007', quantity: 200, itemType: 'item' },
  ]);
});

test('rowsFromSnapshot extracts and names rows', () => {
  const envelope = JSON.stringify({
    InitialSubscription: {
      database_update: {
        tables: [{
          table_name: 'traveler_task_desc',
          updates: [{ deletes: [], inserts: [POSITIONAL_ROW] }],
        }],
      },
    },
  });
  const rows = rowsFromSnapshot(parseEnvelope(envelope), 'traveler_task_desc', TASK_COLUMNS);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 1805868417);
  assert.equal(skillIdOf(rows[0]), 15);
});

test('rowsFromSnapshot returns empty for a table not in the snapshot', () => {
  assert.deepEqual(rowsFromSnapshot(parseEnvelope(TIMER_ENVELOPE), 'item_desc'), []);
});
