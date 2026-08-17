/**
 * Fetch current stock for the containers a guild has chosen to track.
 *
 * Only selected containers count. A tracked container that is absent from the
 * response is reported rather than silently counted as zero — a player's
 * container list is not stable between fetches (DESIGN.md §4.14), and "the
 * wagon is gone" should not read as "you are out of planks".
 */
import { discoverContainers } from './discover.mjs';
import { tally } from './normalize.mjs';

export async function fetchTrackedStock(storages = []) {
  const totals = new Map();
  const missing = [];
  const errors = [];
  let containerCount = 0;

  for (const storage of storages) {
    try {
      const found = await discoverContainers(storage.source, { cacheHouseList: true });
      const byId = new Map(found.map((c) => [String(c.id), c]));

      const selected = [];
      for (const wanted of storage.containers ?? []) {
        const hit = byId.get(String(wanted.id));
        if (hit) selected.push(hit);
        else missing.push({ source: storage.source.name, name: wanted.name, id: wanted.id });
      }

      containerCount += selected.length;
      tally(selected, totals);
    } catch (err) {
      errors.push({ source: storage.source.name, message: err.message });
    }
  }

  return { totals, missing, errors, containerCount };
}
