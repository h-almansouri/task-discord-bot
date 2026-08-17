import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '../src/config/store.mjs';
import {
  resolveTarget, inTierRange, unconfiguredMaterials,
  isExcluded, watchedMaterials, familiesOf,
} from '../src/tracker/thresholds.mjs';
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

test('a global varying-quantity default covers every such material', () => {
  const config = withTracked({}, { variableDefault: 50 });
  for (const [who, material] of [['Svim', salt], ['Ramparte', fur]]) {
    const r = resolveTarget(config, who, material);
    assert.equal(r.target, 50, `${material.name} should use the global default`);
    assert.equal(r.basis, 'variable-global');
    assert.equal(r.configured, true);
  }
});

test('a per-traveler varying default beats the global one', () => {
  const config = withTracked({}, {
    variableDefault: 50,
    overrides: { Ramparte: { variableDefault: 5 } },
  });
  assert.equal(resolveTarget(config, 'Ramparte', fur).target, 5);
  assert.equal(resolveTarget(config, 'Svim', salt).target, 50);
});

test('a per-material threshold still beats both varying defaults', () => {
  const config = withTracked({}, {
    variableDefault: 50,
    overrides: { Svim: { variableDefault: 20 } },
    absolute: { 'item:1110015': 500 },
  });
  const r = resolveTarget(config, 'Svim', salt);
  assert.equal(r.target, 500);
  assert.equal(r.basis, 'absolute');
});

test('the varying default does not touch fixed-quantity materials', () => {
  // Those follow turn-ins; a blanket number must not hijack them.
  const config = withTracked({}, { variableDefault: 7, turnIns: 5 });
  const r = resolveTarget(config, 'Alesi', grain(1));
  assert.equal(r.target, 1000);
  assert.equal(r.basis, 'global');
});

test('setting the varying default clears the awaiting-a-threshold warning', () => {
  const before = withTracked({ Svim: { tiers: [1, 10] } });
  assert.equal(unconfiguredMaterials(before, 'Svim', RULEBOOK.travelers.Svim).length, 1);

  const after = withTracked({ Svim: { tiers: [1, 10] } }, { variableDefault: 50 });
  assert.equal(unconfiguredMaterials(after, 'Svim', RULEBOOK.travelers.Svim).length, 0);
});

test('a varying default of zero is honoured, not treated as unset', () => {
  // 0 is falsy but a legitimate "never flag this" value.
  const config = withTracked({}, { variableDefault: 0 });
  const r = resolveTarget(config, 'Ramparte', fur);
  assert.equal(r.target, 0);
  assert.equal(r.configured, true);
});

test('the varying default feeds through to shortfalls', () => {
  const config = withTracked({ Svim: { tiers: [1, 10] } }, { variableDefault: 50 });
  const r = computeShortfalls({ rulebook: RULEBOOK, config, stock: new Map([['item:1110015', 20]]) });
  const row = r.travelers[0].groups.flatMap((g) => g.rows).find((x) => x.name === 'Salt');
  assert.equal(row.target, 50);
  assert.equal(row.short, 30);
  assert.equal(r.travelers[0].unconfigured.length, 0);
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

// --- exclusions ------------------------------------------------------------

const withExclusion = (name, families) => withTracked({
  [name]: { tiers: [1, 10], excluded: families },
});

test('an excluded family is not watched at any tier', () => {
  const config = withExclusion('Alesi', ['Grain']);
  for (const tier of [1, 2, 3]) {
    assert.equal(isExcluded(config, 'Alesi', grain(tier)), true, `T${tier} should be excluded`);
  }
});

test('exclusions are case-insensitive', () => {
  assert.equal(isExcluded(withExclusion('Alesi', ['grain']), 'Alesi', grain(1)), true);
  assert.equal(isExcluded(withExclusion('Alesi', ['GRAIN']), 'Alesi', grain(1)), true);
});

test('exclusions apply only to the traveler they were set on', () => {
  const config = withTracked({
    Alesi: { tiers: [1, 10], excluded: ['Grain'] },
    Svim: { tiers: [1, 10] },
  });
  assert.equal(isExcluded(config, 'Alesi', grain(1)), true);
  assert.equal(isExcluded(config, 'Svim', grain(1)), false);
});

test('an excluded family produces no shortfalls', () => {
  const stock = new Map();
  const before = computeShortfalls({
    rulebook: RULEBOOK, config: withTracked({ Alesi: { tiers: [1, 10] } }), stock,
  });
  assert.equal(before.totalShort, 3);

  const after = computeShortfalls({
    rulebook: RULEBOOK, config: withExclusion('Alesi', ['Grain']), stock,
  });
  assert.equal(after.totalShort, 0);
  assert.equal(after.travelers.length, 0, 'a traveler with everything excluded should vanish');
});

test('excluding a variable material stops it asking for a threshold', () => {
  const tracked = withTracked({ Svim: { tiers: [1, 10] } });
  assert.equal(unconfiguredMaterials(tracked, 'Svim', RULEBOOK.travelers.Svim).length, 1);

  const excluded = withExclusion('Svim', ['Salt']);
  assert.equal(unconfiguredMaterials(excluded, 'Svim', RULEBOOK.travelers.Svim).length, 0);
});

test('watchedMaterials reflects both the tier range and exclusions', () => {
  const all = withTracked({ Alesi: { tiers: [1, 10] } });
  assert.equal(watchedMaterials(all, 'Alesi', RULEBOOK.travelers.Alesi).length, 3);

  const narrow = withTracked({ Alesi: { tiers: [1, 2] } });
  assert.equal(watchedMaterials(narrow, 'Alesi', RULEBOOK.travelers.Alesi).length, 2);

  const none = withExclusion('Alesi', ['Grain']);
  assert.equal(watchedMaterials(none, 'Alesi', RULEBOOK.travelers.Alesi).length, 0);
});

test('no exclusions configured means nothing is excluded', () => {
  assert.equal(isExcluded(withTracked({ Alesi: { tiers: [1, 10] } }), 'Alesi', grain(1)), false);
  assert.equal(isExcluded(defaultConfig(), 'Alesi', grain(1)), false);
});

test('familiesOf lists each family once with its tier count', () => {
  const families = familiesOf(RULEBOOK.travelers.Alesi);
  assert.deepEqual(families, [{ name: 'Grain', count: 3 }]);
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

test('a family is a name line plus one pipe-separated row of tiers', () => {
  const rows = [1, 2, 3].map((t) => ({ ...grain(t), have: 0, target: 1000, short: 1000 }));
  const text = renderGroup(groupShortfalls(rows)[0]);
  assert.equal(text.split('\n').length, 2);
  assert.match(text, /^\*\*Grain\*\*$/m);
  assert.match(text, /T1 1,000 \| T2 1,000 \| T3 1,000/);
});

test('deficits are plain numbers, with no minus sign', () => {
  const rows = [1, 2].map((t) => ({ ...grain(t), have: 0, target: 1000, short: 1000 }));
  const text = renderGroup(groupShortfalls(rows)[0]);
  assert.doesNotMatch(text, /[−-]\s*1,000/, 'numbers should not be prefixed with a minus');
});

test('a family with a single tier stays on one line', () => {
  const text = renderGroup(groupShortfalls([{ ...grain(3), have: 900, target: 1000, short: 100 }])[0]);
  assert.equal(text.split('\n').length, 1);
  assert.match(text, /\*\*Grain\*\* T3 100/);
});

test('the word "short" is not repeated on every row', () => {
  const rows = [1, 2, 3].map((t) => ({ ...grain(t), have: 0, target: 1000, short: 1000 }));
  const text = renderGroup(groupShortfalls(rows)[0]);
  assert.doesNotMatch(text, /short/i, 'the footer states this once; rows should not repeat it');
});

test('targets are not shown anywhere in a family line', () => {
  const rows = [1, 2].map((t) => ({ ...grain(t), have: 0, target: 1000, short: 1000 }));
  const text = renderGroup(groupShortfalls(rows)[0]);
  assert.doesNotMatch(text, /\/tier/, 'the per-tier target should be gone');
  assert.doesNotMatch(text, /0\/1,000/, 'the have/target pair should be gone');
});

test('tiers still share a line when their targets differ', () => {
  // Targets are no longer rendered, so uniformity of target no longer matters —
  // only whether every row is tiered and no tier repeats.
  const rows = [
    { ...grain(1), have: 0, target: 1000, short: 1000 },
    { ...grain(2), have: 0, target: 400, short: 400 },
  ];
  const text = renderGroup(groupShortfalls(rows)[0]);
  assert.equal(text.split('\n').length, 2);
  assert.match(text, /T1 1,000 \| T2 400/);
});

test('untiered materials render by name, one per line', () => {
  const text = renderGroup(groupShortfalls([{ ...fur, have: 0, target: 50, short: 50 }])[0]);
  assert.match(text, /\*\*Jakyl Fur\*\* 50/);
  assert.doesNotMatch(text, /T-1/);
});

test('a family whose tiers repeat falls back to naming each material', () => {
  // Heimlich's foods all share one tag and five of them sit on every tier.
  // Collapsing those into a tier row would read as one family holding two
  // values for T1.
  const rows = [
    { key: 'a', name: 'Plain Cooked Berries', tier: 1, tag: 'Basic Food', family: 'Food', have: 0, target: 50, short: 40 },
    { key: 'b', name: 'Plain Mashed Bulbs', tier: 1, tag: 'Basic Food', family: 'Food', have: 0, target: 50, short: 46 },
  ];
  const text = renderGroup(groupShortfalls(rows)[0]);
  assert.doesNotMatch(text, /T1 40 \| T1 46/, 'a repeated tier must not collapse into one row');
  assert.match(text, /Plain Cooked Berries/);
  assert.match(text, /Plain Mashed Bulbs/);
});

test('one tag covering several product lines splits into separate families', () => {
  const rows = [
    { key: 'a', name: 'Plain Cooked Berries', tier: 1, tag: 'Basic Food', family: 'Cooked Berries', have: 0, target: 50, short: 40 },
    { key: 'b', name: 'Savory Cooked Berries', tier: 2, tag: 'Basic Food', family: 'Cooked Berries', have: 0, target: 50, short: 41 },
    { key: 'c', name: 'Plain Mashed Bulbs', tier: 1, tag: 'Basic Food', family: 'Mashed Bulbs', have: 0, target: 50, short: 46 },
  ];
  const groups = groupShortfalls(rows);
  assert.equal(groups.length, 2, 'the shared tag should not merge two product lines');
  assert.deepEqual(groups.map((g) => g.label).sort(), ['Cooked Berries', 'Mashed Bulbs']);
});

test('the family label is preferred over the raw tag', () => {
  // "Vegetable" is the tag that groups Starbulb; players know it as Starbulb.
  const rows = [1, 2].map((t) => ({
    ...grain(t), tag: 'Vegetable', family: 'Starbulb', have: 0, target: 150, short: 150,
  }));
  const text = renderGroup(groupShortfalls(rows)[0]);
  assert.match(text, /\*\*Starbulb\*\*/);
  assert.doesNotMatch(text, /Vegetable/);
});

// --- timestamp -------------------------------------------------------------

test('the tracker carries a native timestamp Discord can render', () => {
  const stock = new Map();
  const { embeds } = renderTracker(
    computeShortfalls({ rulebook: RULEBOOK, config: withTracked({ Alesi: { tiers: [1, 10] } }), stock }),
    { updatedAt: Date.parse('2026-08-17T02:00:00Z'), storageCount: 3 },
  );
  const last = embeds[embeds.length - 1];
  assert.equal(last.timestamp, '2026-08-17T02:00:00.000Z');
});

test('regression: no <t:…> tag is placed where Discord renders it literally', () => {
  // Footer and author text are plain — a timestamp tag there shows as raw
  // characters, which is exactly the bug this replaced.
  const cases = [
    computeShortfalls({ rulebook: RULEBOOK, config: defaultConfig(), stock: new Map() }),
    computeShortfalls({
      rulebook: RULEBOOK, config: withTracked({ Alesi: { tiers: [1, 10] } }),
      stock: new Map([['item:grain1', 9e9], ['item:grain2', 9e9], ['item:grain3', 9e9]]),
    }),
    computeShortfalls({ rulebook: RULEBOOK, config: withTracked({ Alesi: { tiers: [1, 10] } }), stock: new Map() }),
  ];
  for (const result of cases) {
    for (const e of renderTracker(result, { updatedAt: Date.now(), storageCount: 1 }).embeds) {
      assert.doesNotMatch(e.footer?.text ?? '', /<t:/, 'timestamp tag in footer text');
      assert.doesNotMatch(e.description ?? '', /<t:/, 'timestamp tag left in description');
      assert.doesNotMatch(e.title ?? '', /<t:/, 'timestamp tag in title');
    }
  }
});

test('every embed variant sets a timestamp', () => {
  const variants = [
    computeShortfalls({ rulebook: RULEBOOK, config: defaultConfig(), stock: new Map() }),
    computeShortfalls({
      rulebook: RULEBOOK, config: withTracked({ Alesi: { tiers: [1, 10] } }),
      stock: new Map([['item:grain1', 9e9], ['item:grain2', 9e9], ['item:grain3', 9e9]]),
    }),
    computeShortfalls({ rulebook: RULEBOOK, config: withTracked({ Alesi: { tiers: [1, 10] } }), stock: new Map() }),
  ];
  for (const result of variants) {
    const { embeds } = renderTracker(result, { storageCount: 1 });
    assert.ok(embeds[embeds.length - 1].timestamp, 'last embed should carry a timestamp');
  }
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

test('the 10-embed cap holds even when everything fits on characters', () => {
  // Regression: with a compact layout the character budget no longer bites
  // first, so the embed count became the real limit. 20 tiny travelers fit in
  // 6000 characters easily but must still yield at most 10 embeds.
  const travelers = {}; const config = { ...defaultConfig(), travelers: {} };
  for (let t = 0; t < 20; t++) {
    const name = `T${t}`;
    travelers[name] = {
      materials: [{
        key: `item:t${t}`, name: 'X', tier: 1, tag: 'F', family: 'F',
        fixed: true, perTurnIn: 1, quantities: [1],
      }],
    };
    config.travelers[name] = { tiers: [1, 10] };
  }
  const { embeds } = renderTracker(
    computeShortfalls({ rulebook: { travelers }, config, stock: new Map() }),
    { storageCount: 1 },
  );
  const total = embeds.reduce((n, e) => n + embedLength(e), 0);
  assert.ok(total < 6000, 'this case should be well inside the character budget');
  assert.ok(embeds.length <= 10, `rendered ${embeds.length} embeds, over Discord's cap`);
  assert.match(embeds[embeds.length - 1].footer.text, /omitted/, 'dropped travelers should be disclosed');
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
