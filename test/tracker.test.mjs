import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '../src/config/store.mjs';
import { resolveTarget, inTierRange, unconfiguredMaterials } from '../src/tracker/thresholds.mjs';
import { computeShortfalls, groupShortfalls } from '../src/tracker/shortfall.mjs';
import { renderTracker, renderGroup, embedLength, contentHash } from '../src/tracker/render.mjs';

const grain = (tier) => ({
  key: `item:grain${tier}`, name: `T${tier} Embergrain`, tier, tag: 'Grain',
  fixed: true, perTurnIn: 200, quantities: [200],
});
const salt = {
  key: 'item:1110015', name: 'Salt', tier: 1, tag: 'Salt',
  fixed: false, perTurnIn: null, quantities: [10, 20, 55],
};
const fur = {
  key: 'item:767727086', name: 'Jakyl Fur', tier: -1, tag: 'Hide',
  fixed: false, perTurnIn: null, quantities: [1, 5, 10],
};

const RULEBOOK = {
  counts: { tasks: 3 },
  travelers: {
    Alesi: { materials: [grain(1), grain(2), grain(3)] },
    Svim: { materials: [salt] },
    Ramparte: { materials: [fur] },
  },
};

const withTracked = (travelers, extra = {}) => ({ ...defaultConfig(), travelers, ...extra });

// --- thresholds ------------------------------------------------------------

test('global turn-ins give the default target', () => {
  const r = resolveTarget(withTracked({}), 'Alesi', grain(1));
  assert.equal(r.target, 1000);          // 5 × 200
  assert.equal(r.basis, 'global');
});

test('a per-traveler override beats the global default', () => {
  const config = withTracked({}, { overrides: { Alesi: { turnIns: 8 } } });
  assert.equal(resolveTarget(config, 'Alesi', grain(1)).target, 1600);
});

test('a per-material override beats the per-traveler one', () => {
  const config = withTracked({}, {
    overrides: { Alesi: { turnIns: 8, materials: { 'item:grain1': { turnIns: 2 } } } },
  });
  assert.equal(resolveTarget(config, 'Alesi', grain(1)).target, 400);
  assert.equal(resolveTarget(config, 'Alesi', grain(2)).target, 1600);
});

test('an absolute number beats everything', () => {
  const config = withTracked({}, {
    turnIns: 5, overrides: { Alesi: { turnIns: 8 } }, absolute: { 'item:grain1': 42 },
  });
  const r = resolveTarget(config, 'Alesi', grain(1));
  assert.equal(r.target, 42);
  assert.equal(r.basis, 'absolute');
});

test('a variable material without an absolute is unconfigured, not guessed', () => {
  const r = resolveTarget(withTracked({}), 'Svim', salt);
  assert.equal(r.configured, false);
  assert.equal(r.target, null);
});

test('a variable material with an absolute becomes usable', () => {
  const config = withTracked({}, { absolute: { 'item:1110015': 500 } });
  const r = resolveTarget(config, 'Svim', salt);
  assert.equal(r.target, 500);
  assert.equal(r.configured, true);
});

test('tier range filters tiered materials', () => {
  assert.equal(inTierRange(grain(3), [1, 5]), true);
  assert.equal(inTierRange(grain(7), [1, 5]), false);
});

test('untiered combat drops survive any tier range', () => {
  // Ramparte's drops are tier -1; a 1-5 range would otherwise track nothing.
  assert.equal(inTierRange(fur, [1, 5]), true);
  assert.equal(inTierRange(fur, [8, 10]), true);
});

test('unconfiguredMaterials lists exactly what still needs a number', () => {
  const config = withTracked({ Ramparte: { tiers: [1, 5] } });
  const pending = unconfiguredMaterials(config, 'Ramparte', RULEBOOK.travelers.Ramparte);
  assert.deepEqual(pending.map((m) => m.name), ['Jakyl Fur']);
});

// --- shortfalls ------------------------------------------------------------

test('only materials below target are reported', () => {
  const stock = new Map([['item:grain1', 1000], ['item:grain2', 300]]);
  const r = computeShortfalls({ rulebook: RULEBOOK, config: withTracked({ Alesi: { tiers: [1, 10] } }), stock });
  const rows = r.travelers[0].groups.flatMap((g) => g.rows);
  assert.deepEqual(rows.map((x) => x.tier).sort(), [2, 3]);   // T1 is stocked
  assert.equal(rows.find((x) => x.tier === 2).short, 700);
});

test('a fully stocked traveler produces no section', () => {
  const stock = new Map([['item:grain1', 9999], ['item:grain2', 9999], ['item:grain3', 9999]]);
  const r = computeShortfalls({ rulebook: RULEBOOK, config: withTracked({ Alesi: { tiers: [1, 10] } }), stock });
  assert.equal(r.travelers.length, 0);
  assert.equal(r.totalShort, 0);
});

test('tier range narrows what is checked', () => {
  const r = computeShortfalls({
    rulebook: RULEBOOK, config: withTracked({ Alesi: { tiers: [1, 2] } }), stock: new Map(),
  });
  assert.equal(r.travelers[0].shortCount, 2);
});

test('unconfigured materials are surfaced, not counted as shortfalls', () => {
  const r = computeShortfalls({
    rulebook: RULEBOOK, config: withTracked({ Svim: { tiers: [1, 10] } }), stock: new Map(),
  });
  assert.equal(r.travelers[0].shortCount, 0);
  assert.deepEqual(r.travelers[0].unconfigured.map((m) => m.name), ['Salt']);
});

test('travelers with the most shortfalls come first', () => {
  const config = withTracked({ Alesi: { tiers: [1, 10] }, Svim: { tiers: [1, 10] } },
    { absolute: { 'item:1110015': 10 } });
  const r = computeShortfalls({ rulebook: RULEBOOK, config, stock: new Map() });
  assert.equal(r.travelers[0].name, 'Alesi');
});

test('an untracked traveler contributes nothing', () => {
  const r = computeShortfalls({ rulebook: RULEBOOK, config: defaultConfig(), stock: new Map() });
  assert.equal(r.anyTracked, false);
  assert.equal(r.travelers.length, 0);
});

test('groupShortfalls marks a family with one shared target as uniform', () => {
  const rows = [1, 2, 3].map((t) => ({ ...grain(t), have: 0, target: 1000, short: 1000 }));
  const [group] = groupShortfalls(rows);
  assert.equal(group.uniformTarget, 1000);
  assert.equal(group.perTurnIn, 200);
});

// --- rendering -------------------------------------------------------------

test('a uniform family collapses to two lines', () => {
  const rows = [1, 2, 3].map((t) => ({ ...grain(t), have: 0, target: 1000, short: 1000 }));
  const text = renderGroup(groupShortfalls(rows)[0]);
  assert.equal(text.split('\n').length, 2);
  assert.match(text, /200\/turn-in/);
  assert.match(text, /T1 \*\*1,000\*\*/);
});

test('mixed targets fall back to one line per material', () => {
  const rows = [
    { ...grain(1), have: 0, target: 1000, short: 1000 },
    { ...grain(2), have: 0, target: 400, short: 400 },
  ];
  const text = renderGroup(groupShortfalls(rows)[0]);
  assert.equal(text.split('\n').length, 2);
  assert.match(text, /T1/);
});

test('untiered materials render by name, not as T-1', () => {
  const text = renderGroup(groupShortfalls([{ ...fur, have: 0, target: 50, short: 50 }])[0]);
  assert.match(text, /Jakyl Fur/);
  assert.doesNotMatch(text, /T-1/);
});

test('nothing tracked yields a prompt to add a traveler', () => {
  const { embeds } = renderTracker(computeShortfalls({
    rulebook: RULEBOOK, config: defaultConfig(), stock: new Map(),
  }));
  assert.match(embeds[0].description, /No travelers tracked/);
});

test('everything stocked yields one all-clear embed', () => {
  const stock = new Map([['item:grain1', 9999], ['item:grain2', 9999], ['item:grain3', 9999]]);
  const { embeds } = renderTracker(computeShortfalls({
    rulebook: RULEBOOK, config: withTracked({ Alesi: { tiers: [1, 10] } }), stock,
  }));
  assert.equal(embeds.length, 1);
  assert.match(embeds[0].title, /all stocked/);
});

test('the rendered message never exceeds Discord\'s 6000-character budget', () => {
  // 20 travelers, 40 materials each — far beyond any real config.
  const travelers = {}; const config = { ...defaultConfig(), travelers: {} };
  for (let t = 0; t < 20; t++) {
    const name = `Traveler${t}`;
    travelers[name] = {
      materials: Array.from({ length: 40 }, (_, i) => ({
        key: `item:t${t}m${i}`, name: `Really Quite Long Material Name ${i}`,
        tier: (i % 10) + 1, tag: `Family${i % 4}`, fixed: true, perTurnIn: 100 + i, quantities: [100 + i],
      })),
    };
    config.travelers[name] = { tiers: [1, 10] };
  }
  const { embeds } = renderTracker(
    computeShortfalls({ rulebook: { travelers }, config, stock: new Map() }),
    { updatedAt: Date.now(), storageCount: 5 },
  );
  const total = embeds.reduce((n, e) => n + embedLength(e), 0);
  assert.ok(total <= 6000, `rendered ${total} characters, over the limit`);
  assert.ok(embeds.length <= 10, 'Discord allows at most 10 embeds per message');
});

test('truncation is disclosed rather than silent', () => {
  const travelers = {}; const config = { ...defaultConfig(), travelers: {} };
  for (let t = 0; t < 20; t++) {
    const name = `Traveler${t}`;
    travelers[name] = {
      materials: Array.from({ length: 40 }, (_, i) => ({
        key: `item:t${t}m${i}`, name: `Material ${i} with a fairly long name`,
        tier: (i % 10) + 1, tag: `Fam${i}`, fixed: true, perTurnIn: 100, quantities: [100],
      })),
    };
    config.travelers[name] = { tiers: [1, 10] };
  }
  const { embeds } = renderTracker(
    computeShortfalls({ rulebook: { travelers }, config, stock: new Map() }),
    { storageCount: 1 },
  );
  const text = JSON.stringify(embeds);
  assert.ok(/truncated|omitted/.test(text), 'dropped content should be disclosed');
});

test('contentHash ignores the clock so unchanged stock does not redraw', () => {
  const run = () => computeShortfalls({
    rulebook: RULEBOOK, config: withTracked({ Alesi: { tiers: [1, 10] } }),
    stock: new Map([['item:grain1', 10]]),
  });
  assert.equal(contentHash(run()), contentHash(run()));
});

test('contentHash changes when stock changes', () => {
  const at = (n) => computeShortfalls({
    rulebook: RULEBOOK, config: withTracked({ Alesi: { tiers: [1, 10] } }),
    stock: new Map([['item:grain1', n]]),
  });
  assert.notEqual(contentHash(at(10)), contentHash(at(20)));
});
