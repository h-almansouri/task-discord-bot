/**
 * bitjita returns container contents in three different shapes depending on the
 * endpoint (DESIGN.md §4.13). Normalising at the boundary is not cosmetic: a
 * missed shape reads as "you have zero of everything", which looks like a real
 * shortfall rather than a bug.
 *
 *   claim  /claims/{id}/inventories        building.inventory[]     item_id / item_type
 *   player /players/{id}/inventories       inventories[].pockets[]  itemId  / itemType
 *   house  /players/{id}/housing/{houseId} inventories[].inventory[] item_id / item_type
 *
 * `item_type` is also inconsistent: a string ("item"/"cargo") on claim and house
 * responses, a number (0/1) on player responses.
 */

/** Pocket array for a container, whichever endpoint it came from. */
export function pocketsOf(container) {
  if (!container) return [];
  if (Array.isArray(container.pockets)) return container.pockets;
  if (Array.isArray(container.inventory)) return container.inventory;
  return [];
}

/** "item" | "cargo" from either the string or numeric encoding. */
export function itemTypeOf(value) {
  if (value === 1 || value === 'cargo') return 'cargo';
  return 'item';
}

/**
 * Stable key for an item. Item and cargo ids share a numbering space — cargo 1
 * is not item 1 — so the type must be part of the key.
 */
export function itemKey(itemType, itemId) {
  return `${itemTypeOf(itemType)}:${itemId}`;
}

/** One pocket's contents, or null when the pocket is empty. */
export function contentsOf(pocket) {
  const c = pocket?.contents;
  if (!c) return null;
  const rawId = c.itemId ?? c.item_id;
  if (rawId == null) return null;
  const itemType = itemTypeOf(c.itemType ?? c.item_type);
  return {
    itemId: String(rawId),
    itemType,
    quantity: c.quantity ?? 0,
    key: itemKey(itemType, rawId),
  };
}

/**
 * Sum quantities across containers into Map<itemKey, quantity>.
 * Accepts containers from any of the three endpoint shapes.
 */
export function tally(containers, into = new Map()) {
  for (const container of containers ?? []) {
    for (const pocket of pocketsOf(container)) {
      const c = contentsOf(pocket);
      if (!c) continue;
      into.set(c.key, (into.get(c.key) ?? 0) + c.quantity);
    }
  }
  return into;
}

/**
 * Containers a claim response exposes, flattened to a common shape.
 * Nickname wins over the generic building name — it is what a player recognises.
 */
export function claimContainers(payload) {
  return (payload?.buildings ?? []).map((b) => ({
    id: String(b.entityId),
    name: b.buildingNickname || b.buildingName || '(unnamed)',
    origin: 'claim',
    pockets: b.inventory ?? [],
  }));
}

/** Containers from a player `/inventories` response. */
export function playerContainers(payload, playerId) {
  return (payload?.inventories ?? []).map((inv) => {
    const personal = playerId != null && String(inv.ownerEntityId) === String(playerId);
    return {
      id: String(inv.entityId),
      name: inv.inventoryName || inv.buildingName || '(unnamed)',
      origin: personal ? 'personal' : 'bank',
      claimName: inv.claimName ?? null,
      pockets: inv.pockets ?? [],
    };
  });
}

/** Containers from a `/housing/{houseId}` response. */
export function houseContainers(payload) {
  return (payload?.inventories ?? []).map((inv) => ({
    id: String(inv.entityId),
    name: inv.buildingNickname || inv.buildingName || '(unnamed)',
    origin: 'house',
    pockets: inv.inventory ?? [],
  }));
}
