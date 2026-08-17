/**
 * How much of a material we want in stock (DESIGN.md §5).
 *
 * Most materials are asked for at one fixed quantity per task, so the target is
 * simply `turnIns × perTurnIn`. Eight are asked for at several different
 * quantities, where that maths is meaningless — those need an absolute number,
 * and are reported as unconfigured until one is set rather than guessed at.
 */

/** Resolution order, first match wins. */
export function resolveTarget(config, travelerName, material) {
  const absolute = config.absolute?.[material.key];
  if (Number.isFinite(absolute)) {
    return { target: absolute, basis: 'absolute', configured: true };
  }

  if (!material.fixed) {
    // Variable quantity with no absolute set: nothing sensible to compute.
    return { target: null, basis: 'variable', configured: false };
  }

  const override = config.overrides?.[travelerName];
  const perMaterial = override?.materials?.[material.key]?.turnIns;
  if (Number.isFinite(perMaterial)) {
    return { target: perMaterial * material.perTurnIn, basis: 'material', turnIns: perMaterial, configured: true };
  }

  if (Number.isFinite(override?.turnIns)) {
    return { target: override.turnIns * material.perTurnIn, basis: 'traveler', turnIns: override.turnIns, configured: true };
  }

  const global = Number.isFinite(config.turnIns) ? config.turnIns : 5;
  return { target: global * material.perTurnIn, basis: 'global', turnIns: global, configured: true };
}

/**
 * Whether a material falls inside a traveler's configured tier range.
 *
 * Untiered materials — combat drops carry tier -1 — are always included. A tier
 * range of 1-5 would otherwise silently exclude every one of Ramparte's drops,
 * leaving that traveler tracking nothing.
 */
export function inTierRange(material, tiers) {
  if (material.tier == null || material.tier < 1) return true;
  if (!Array.isArray(tiers) || tiers.length !== 2) return true;
  const [min, max] = tiers;
  return material.tier >= min && material.tier <= max;
}

/**
 * Whether a material family has been switched off for this traveler.
 *
 * Exclusions are by family, the unit the tracker displays, so dropping
 * "Experimental Compounds" removes all ten of its tiers at once. To hide a
 * single tier instead, give that one material a threshold of 0.
 */
export function isExcluded(config, travelerName, material) {
  const excluded = config.travelers?.[travelerName]?.excluded;
  if (!Array.isArray(excluded) || !excluded.length) return false;
  const family = String(material.family ?? material.tag ?? '').toLowerCase();
  return excluded.some((e) => String(e).toLowerCase() === family);
}

/** Materials of a tracked traveler that are actually being watched. */
export function watchedMaterials(config, travelerName, traveler) {
  const tiers = config.travelers?.[travelerName]?.tiers;
  return traveler.materials
    .filter((m) => !isExcluded(config, travelerName, m))
    .filter((m) => inTierRange(m, tiers));
}

/** Materials of a tracked traveler that still need an absolute number. */
export function unconfiguredMaterials(config, travelerName, traveler) {
  return watchedMaterials(config, travelerName, traveler)
    .filter((m) => !resolveTarget(config, travelerName, m).configured);
}

/** Every distinct family a traveler can ask for, in display order. */
export function familiesOf(traveler) {
  const seen = new Map();
  for (const m of traveler.materials ?? []) {
    const family = m.family ?? m.tag ?? 'Other';
    seen.set(family, (seen.get(family) ?? 0) + 1);
  }
  return [...seen.entries()].map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
