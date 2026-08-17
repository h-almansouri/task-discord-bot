import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '../src/config/store.mjs';
import {
  resolveTarget, inTierRange, unconfiguredMaterials,
  isExcluded, watchedMaterials, familiesOf, bandFor,
} from '../src/tracker/thresholds.mjs';
import { computeShortfalls, groupShortfalls } from '../src/tracker/shortfall.mjs';
import {
  renderTraveler, renderEmpty, renderTable, renderUntiered,
  formatDiff, embedLength, travelerHash,
} from '../src/tracker/render.mjs';

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

// --- tier bands ------------------------------------------------------------

const BANDS = [{ tiers: [1, 4], turnIns: 250 }, { tiers: [5, 6], turnIns: 500 }];

test('a band applies its turn-ins to tiers inside its range', () => {
  const config = withTracked({}, { tierBands: BANDS, turnIns: 5 });
  assert.equal(resolveTarget(config, 'Alesi', grain(1)).target, 250 * 200);
  assert.equal(resolveTarget(config, 'Alesi', grain(3)).target, 250 * 200);
});

test('a second band covers its own range', () => {
  const config = withTracked({}, { tierBands: BANDS, turnIns: 5 });
  const r = resolveTarget(config, 'Alesi', { ...grain(5), tier: 5 });
  assert.equal(r.target, 500 * 200);
  assert.deepEqual(r.band, [5, 6]);
});

test('tiers outside every band fall back to the plain turn-in count', () => {
  const config = withTracked({}, { tierBands: BANDS, turnIns: 5 });
  const r = resolveTarget(config, 'Alesi', { ...grain(9), tier: 9 });
  assert.equal(r.target, 5 * 200);
  assert.equal(r.basis, 'global');
});

test('a band costs different amounts per material, by design', () => {
  // "250 turn-ins" means 250 turn-ins' worth, whatever that costs.
  const config = withTracked({}, { tierBands: [{ tiers: [1, 4], turnIns: 250 }] });
  const cheap = { ...grain(1), perTurnIn: 10 };
  const dear = { ...grain(1), perTurnIn: 300 };
  assert.equal(resolveTarget(config, 'Rumbagh', cheap).target, 2500);
  assert.equal(resolveTarget(config, 'Alesi', dear).target, 75000);
});

test('bands never apply to untiered materials', () => {
  // All 15 of Ramparte's materials are tier -1, so no band can match them and
  // he needs no special-casing.
  const config = withTracked({}, { tierBands: BANDS, variableDefault: 25 });
  const r = resolveTarget(config, 'Ramparte', fur);
  assert.equal(r.basis, 'variable-global');
  assert.equal(r.target, 25);
});

test('a per-traveler band beats the global band', () => {
  const config = withTracked({}, {
    tierBands: BANDS,
    overrides: { Alesi: { tierBands: [{ tiers: [1, 4], turnIns: 2 }] } },
  });
  assert.equal(resolveTarget(config, 'Alesi', grain(1)).target, 2 * 200);
  assert.equal(resolveTarget(config, 'Svim', grain(1)).target, 250 * 200);
});

test('a per-traveler turn-in count beats the global band', () => {
  const config = withTracked({}, { tierBands: BANDS, overrides: { Alesi: { turnIns: 3 } } });
  assert.equal(resolveTarget(config, 'Alesi', grain(1)).target, 3 * 200);
});

test('a per-material threshold still beats every band', () => {
  const config = withTracked({}, { tierBands: BANDS, absolute: { 'item:grain1': 7 } });
  assert.equal(resolveTarget(config, 'Alesi', grain(1)).target, 7);
});

test('bandFor picks the band containing a tier, and nothing for untiered', () => {
  assert.deepEqual(bandFor(BANDS, 2)?.tiers, [1, 4]);
  assert.deepEqual(bandFor(BANDS, 6)?.tiers, [5, 6]);
  assert.equal(bandFor(BANDS, 9), null);
  assert.equal(bandFor(BANDS, -1), null);
  assert.equal(bandFor(undefined, 2), null);
});

// --- reporting -------------------------------------------------------------

test('stocked materials are reported alongside short ones', () => {
  const stock = new Map([['item:grain1', 1000], ['item:grain2', 300]]);
  const r = computeShortfalls({ rulebook: RULEBOOK, config: withTracked({ Alesi: { tiers: [1, 10] } }), stock });
  const rows = r.travelers[0].rows;
  assert.equal(rows.length, 3, 'every watched material should appear');
  assert.equal(rows.find((x) => x.tier === 1).diff, 0);      // exactly on target
  assert.equal(rows.find((x) => x.tier === 2).diff, -700);
  assert.equal(r.travelers[0].shortCount, 2);
  assert.equal(r.travelers[0].okCount, 1);
});

test('surplus is a positive diff', () => {
  const stock = new Map([['item:grain1', 4005]]);
  const r = computeShortfalls({ rulebook: RULEBOOK, config: withTracked({ Alesi: { tiers: [1, 1] } }), stock });
  assert.equal(r.travelers[0].rows[0].diff, 3005);
  assert.equal(r.travelers[0].shortCount, 0);
});

test('a fully stocked traveler still gets a section', () => {
  const stock = new Map([['item:grain1', 9999], ['item:grain2', 9999], ['item:grain3', 9999]]);
  const r = computeShortfalls({ rulebook: RULEBOOK, config: withTracked({ Alesi: { tiers: [1, 10] } }), stock });
  assert.equal(r.travelers.length, 1, 'its channel should still show the grid');
  assert.equal(r.totalShort, 0);
  assert.equal(r.travelers[0].okCount, 3);
});

test('tier range narrows what is checked', () => {
  const r = computeShortfalls({
    rulebook: RULEBOOK, config: withTracked({ Alesi: { tiers: [1, 2] } }), stock: new Map(),
  });
  assert.equal(r.travelers[0].shortCount, 2);
  assert.equal(r.travelers[0].rows.length, 2);
});

test('unconfigured materials are surfaced, not counted as shortfalls', () => {
  const r = computeShortfalls({
    rulebook: RULEBOOK, config: withTracked({ Svim: { tiers: [1, 10] } }), stock: new Map(),
  });
  assert.equal(r.travelers[0].shortCount, 0);
  assert.deepEqual(r.travelers[0].unconfigured.map((m) => m.name), ['Salt']);
});

test('an untracked traveler contributes nothing', () => {
  const r = computeShortfalls({ rulebook: RULEBOOK, config: defaultConfig(), stock: new Map() });
  assert.equal(r.anyTracked, false);
  assert.equal(r.travelers.length, 0);
});

test('families with the most gaps are listed first', () => {
  const rows = [
    { key: 'a', name: 'A', tier: 1, tag: 'Fine', family: 'Fine', have: 10, target: 1, diff: 9, short: 0, perTurnIn: 1 },
    { key: 'b', name: 'B', tier: 1, tag: 'Bad', family: 'Bad', have: 0, target: 5, diff: -5, short: 5, perTurnIn: 1 },
    { key: 'c', name: 'C', tier: 2, tag: 'Bad', family: 'Bad', have: 0, target: 5, diff: -5, short: 5, perTurnIn: 1 },
  ];
  assert.deepEqual(groupShortfalls(rows).map((g) => g.label), ['Bad', 'Fine']);
});

// --- rendering -------------------------------------------------------------

const rowFor = (tier, diff, extra = {}) => ({
  key: `item:grain${tier}`, name: `T${tier} Embergrain`, tier, tag: 'Grain', family: 'Embergrain',
  perTurnIn: 200, have: 0, target: 0, diff, short: Math.max(0, -diff), ...extra,
});
const groupFor = (rows) => groupShortfalls(rows);

const strip = (s) => s.replace(/\u001b\[[0-9;]*m/g, '');

test('formatDiff signs the number and abbreviates large values', () => {
  assert.equal(formatDiff(-500), '-500');
  assert.equal(formatDiff(3005), '+3.0k');
  assert.equal(formatDiff(-1480), '-1.5k');
  assert.equal(formatDiff(75000), '+75k');
  assert.equal(formatDiff(0), '0');
});

test('formatDiff stays inside the column width', () => {
  for (const n of [0, -9, 999, -1000, 9999, -75000, 999999]) {
    assert.ok(formatDiff(n).length <= 6, `${n} formatted too wide: ${formatDiff(n)}`);
  }
});

test('the table has a header row and one row per family', () => {
  const rows = [rowFor(1, -100), rowFor(2, 50)];
  const text = strip(renderTable(groupFor(rows), [1, 2]));
  const lines = text.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /MATERIAL\s+T1\s+T2/);
  assert.match(lines[1], /Embergrain/);
});

test('surplus and shortfall are coloured differently', () => {
  // Padding sits between the colour code and the number, so match loosely.
  const text = renderTable(groupFor([rowFor(1, -100), rowFor(2, 50)]), [1, 2]);
  assert.match(text, /\[0;31m\s*-100/, 'a shortfall should be red');
  assert.match(text, /\[0;32m\s*\+50/, 'a surplus should be green');
});

test('a tier a family does not have renders as a dash, not a zero', () => {
  // Rumbagh's Ink stops at T8; a blank must not read as "you have none".
  const text = renderTable(groupFor([rowFor(1, -5)]), [1, 2]);
  assert.match(strip(text), /-\s*$/m);
  assert.ok(text.includes('[0;30m'), 'the gap should use the dim colour');
});

test('columns line up regardless of number width', () => {
  const rows = [rowFor(1, -75000), rowFor(2, 5)];
  const lines = strip(renderTable(groupFor(rows), [1, 2])).split('\n');
  assert.equal(new Set(lines.map((l) => l.length)).size, 1, 'every row should be the same width');
});

test('untiered materials render as a list, not a grid', () => {
  const text = strip(renderUntiered([
    { name: 'Jakyl Fur', tier: -1, diff: -50 },
    { name: 'Chitin', tier: -1, diff: 12 },
  ]));
  assert.match(text, /Jakyl Fur/);
  assert.match(text, /Chitin/);
  assert.doesNotMatch(text, /T-1/);
});

test('renderTraveler wraps the table in an ansi fence', () => {
  const traveler = {
    name: 'Alesi', tiers: [1, 2], rows: [rowFor(1, -100), rowFor(2, 50)],
    groups: groupFor([rowFor(1, -100), rowFor(2, 50)]), shortCount: 1, okCount: 1, unconfigured: [],
  };
  const { embeds } = renderTraveler(traveler, { storageCount: 3 });
  assert.equal(embeds.length, 1);
  assert.match(embeds[0].description, /^```ansi\n/);
  assert.match(embeds[0].description, /```$/);
  assert.match(embeds[0].title, /^Alesi · T1–2$/);
});

test('the embed is red when short and green when stocked', () => {
  const base = {
    name: 'Alesi', tiers: [1, 1], rows: [rowFor(1, -100)],
    groups: groupFor([rowFor(1, -100)]), shortCount: 1, okCount: 0, unconfigured: [],
  };
  assert.equal(renderTraveler(base, {}).embeds[0].color, 0xd9534f);

  const ok = { ...base, rows: [rowFor(1, 100)], groups: groupFor([rowFor(1, 100)]), shortCount: 0, okCount: 1 };
  assert.equal(renderTraveler(ok, {}).embeds[0].color, 0x5cb85c);
});

test('the footer counts short against total, and the timestamp is native', () => {
  const traveler = {
    name: 'Alesi', tiers: [1, 2], rows: [rowFor(1, -100), rowFor(2, 50)],
    groups: groupFor([rowFor(1, -100), rowFor(2, 50)]), shortCount: 1, okCount: 1, unconfigured: [],
  };
  const { embeds } = renderTraveler(traveler, { updatedAt: Date.parse('2026-08-17T02:00:00Z'), storageCount: 3 });
  assert.match(embeds[0].footer.text, /1 of 2 below target · 3 container\(s\)/);
  assert.equal(embeds[0].timestamp, '2026-08-17T02:00:00.000Z');
  assert.doesNotMatch(embeds[0].footer.text, /<t:/);
});

test('a traveler awaiting a threshold says so outside the code block', () => {
  const traveler = {
    name: 'Svim', tiers: [1, 1], rows: [rowFor(1, -5)], groups: groupFor([rowFor(1, -5)]),
    shortCount: 1, okCount: 0, unconfigured: [{ key: 'item:1110015', name: 'Salt' }],
  };
  const { description } = renderTraveler(traveler, {}).embeds[0];
  assert.match(description, /Needs a threshold: Salt/);
  assert.ok(description.indexOf('Salt') > description.lastIndexOf('```'), 'the note belongs after the fence');
});

test('one traveler always fits Discord\'s limits', () => {
  // Rumbagh at ten tiers with eight families is the widest real case.
  const rows = [];
  for (let f = 0; f < 8; f++) {
    for (let tier = 1; tier <= 10; tier++) {
      rows.push({
        key: `item:f${f}t${tier}`, name: `Material ${f}-${tier}`, tier,
        tag: `Family${f}`, family: `Family Number ${f}`, perTurnIn: 100,
        have: 0, target: 75000, diff: -75000, short: 75000,
      });
    }
  }
  const traveler = {
    name: 'Rumbagh', tiers: [1, 10], rows, groups: groupFor(rows),
    shortCount: rows.length, okCount: 0, unconfigured: [],
  };
  const { embeds } = renderTraveler(traveler, { storageCount: 1 });
  assert.ok(embeds.length <= 10);
  assert.ok(embedLength(embeds[0]) <= 6000, `embed was ${embedLength(embeds[0])} characters`);
  assert.ok(embeds[0].description.length <= 4096, 'description must fit its own cap');
});

test('renderEmpty explains itself rather than showing a blank grid', () => {
  const { embeds } = renderEmpty('Alesi');
  assert.match(embeds[0].title, /Alesi/);
  assert.match(embeds[0].description, /storage add/);
});

// --- change detection ------------------------------------------------------

const travelerFor = (diff) => {
  const rows = [rowFor(1, diff)];
  return { name: 'Alesi', tiers: [1, 1], rows, groups: groupFor(rows), shortCount: diff < 0 ? 1 : 0, okCount: 0, unconfigured: [] };
};

test('travelerHash ignores the clock so unchanged stock does not redraw', () => {
  assert.equal(travelerHash(travelerFor(-100)), travelerHash(travelerFor(-100)));
});

test('travelerHash changes when stock changes', () => {
  const a = travelerFor(-100);
  const b = travelerFor(-100);
  b.rows[0].have = 50;
  assert.notEqual(travelerHash(a), travelerHash(b));
});

test('travelerHash is per traveler, so one changing leaves the others alone', () => {
  const alesi = travelerFor(-100);
  const svim = { ...travelerFor(-100), name: 'Svim' };
  assert.notEqual(travelerHash(alesi), travelerHash(svim));
});
