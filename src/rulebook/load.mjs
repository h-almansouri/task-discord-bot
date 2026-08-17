import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const PATH = new URL('../../data/rulebook.json', import.meta.url);

/**
 * Load the committed rulebook. The bot never fetches this at runtime —
 * regenerate it with `npm run rulebook` (DESIGN.md §3).
 */
export async function loadRulebook() {
  try {
    return JSON.parse(await readFile(PATH, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(
        `No rulebook at ${fileURLToPath(PATH)}.\nRun: npm run rulebook`,
      );
    }
    throw err;
  }
}

/** Case-insensitive traveler lookup. */
export function findTraveler(rulebook, name) {
  const wanted = String(name).toLowerCase();
  const hit = Object.entries(rulebook.travelers)
    .find(([n]) => n.toLowerCase() === wanted);
  return hit ? { name: hit[0], ...hit[1] } : null;
}

/** Group a traveler's materials by tag, tiers ascending within each group. */
export function groupByTag(materials) {
  const groups = new Map();
  for (const m of materials) {
    const tag = m.tag ?? 'Other';
    const list = groups.get(tag) ?? [];
    groups.set(tag, list);
    list.push(m);
  }
  for (const list of groups.values()) list.sort((a, b) => (a.tier ?? 0) - (b.tier ?? 0));
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
}
