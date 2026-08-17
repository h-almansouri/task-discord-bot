#!/usr/bin/env node
/**
 * Fetch the rulebook from a relay and write data/rulebook.json.
 *
 * Run this deliberately — after a game patch, or when a new traveler appears.
 * The bot reads the committed file and never calls a relay for this.
 *
 *   npm run rulebook            # default region
 *   npm run rulebook -- 7       # a specific region (they are identical)
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readTables } from '../src/relay/client.mjs';
import { buildRulebook, verifyJoin, RULEBOOK_TABLES } from '../src/rulebook/build.mjs';

const region = Number(process.argv[2] ?? 12);
const out = new URL('../data/rulebook.json', import.meta.url);

const { relay, tables } = await readTables(RULEBOOK_TABLES, {
  region,
  onLog: (m) => console.log(m),
});

const check = verifyJoin(tables.traveler_task_desc, tables.npc_desc);
console.log(`\njoin check: ${check.checked} tasks cross-checked against description text, ` +
  `${check.mismatched} mismatched, ${check.unmapped} unmapped`);
if (check.mismatched > 0) {
  console.error('Refusing to write: the skill join disagrees with the task text.');
  process.exit(1);
}
if (check.unmapped > 0) {
  console.error(`Refusing to write: ${check.unmapped} tasks map to no traveler.`);
  process.exit(1);
}

const rulebook = buildRulebook(tables, {
  generatedAt: new Date().toISOString(),
  source: relay,
  region,
});

await mkdir(new URL('../data/', import.meta.url), { recursive: true });
await writeFile(out, JSON.stringify(rulebook, null, 2) + '\n');

console.log(`\nwrote ${fileURLToPath(out)}`);
console.log(`  ${rulebook.counts.tasks} tasks across ${rulebook.counts.travelers} travelers\n`);
for (const [name, t] of Object.entries(rulebook.travelers)) {
  const variable = t.materials.filter((m) => !m.fixed);
  console.log(
    `  ${name.padEnd(10)} ${String(t.taskCount).padStart(3)} tasks  ` +
    `${String(t.materials.length).padStart(3)} materials  ` +
    `${variable.length ? `${variable.length} need an absolute threshold` : ''}`,
  );
}
