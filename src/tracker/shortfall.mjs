/**
 * Compare tracked stock against traveler targets.
 *
 * Only shortfalls are reported: a material at or above target is not listed,
 * and a traveler with nothing short produces no section at all (DESIGN.md §8).
 */
import { resolveTarget, inTierRange } from './thresholds.mjs';

/**
 * @param rulebook  the committed rulebook
 * @param config    guild config
 * @param stock     Map<itemKey, quantity> from the tally
 * @returns { travelers: [...], totalShort, anyTracked }
 */
export function computeShortfalls({ rulebook, config, stock }) {
  const tracked = Object.entries(config.travelers ?? {});
  const travelers = [];

  for (const [name, settings] of tracked) {
    const traveler = rulebook.travelers?.[name];
    if (!traveler) continue;

    const shortfalls = [];
    const unconfigured = [];

    for (const material of traveler.materials) {
      if (!inTierRange(material, settings.tiers)) continue;

      const resolved = resolveTarget(config, name, material);
      if (!resolved.configured) {
        unconfigured.push(material);
        continue;
      }

      const have = stock.get(material.key) ?? 0;
      if (have >= resolved.target) continue;

      shortfalls.push({
        key: material.key,
        name: material.name,
        tier: material.tier,
        tag: material.tag ?? 'Other',
        perTurnIn: material.perTurnIn,
        basis: resolved.basis,
        have,
        target: resolved.target,
        short: resolved.target - have,
      });
    }

    if (!shortfalls.length && !unconfigured.length) continue;

    travelers.push({
      name,
      tiers: settings.tiers ?? null,
      groups: groupShortfalls(shortfalls),
      shortCount: shortfalls.length,
      unconfigured,
    });
  }

  // Most-short travelers first, so the important ones survive truncation.
  travelers.sort((a, b) => b.shortCount - a.shortCount);

  return {
    travelers,
    totalShort: travelers.reduce((n, t) => n + t.shortCount, 0),
    anyTracked: tracked.length > 0,
  };
}

/** Bucket a traveler's shortfalls by material family, tiers ascending. */
export function groupShortfalls(shortfalls) {
  const byTag = new Map();
  for (const s of shortfalls) {
    const list = byTag.get(s.tag) ?? [];
    byTag.set(s.tag, list);
    list.push(s);
  }
  return [...byTag.entries()]
    .map(([tag, rows]) => {
      rows.sort((a, b) => (a.tier ?? 0) - (b.tier ?? 0));
      return {
        tag,
        rows,
        // A family shares one per-turn-in quantity when every row agrees, which
        // lets the renderer collapse it to a single line.
        uniformTarget: new Set(rows.map((r) => r.target)).size === 1 ? rows[0].target : null,
        perTurnIn: new Set(rows.map((r) => r.perTurnIn)).size === 1 ? rows[0].perTurnIn : null,
      };
    })
    .sort((a, b) => b.rows.length - a.rows.length);
}
