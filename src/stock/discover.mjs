/**
 * Discovering the containers a source exposes, and the pure helpers the picker
 * needs. Kept free of Discord types so it can be tested without a gateway.
 *
 * A player's storage spans two endpoints that do not overlap: `/inventories`
 * misses their house entirely (DESIGN.md §4.11).
 */
import {
  playerInventories, playerHousing, houseDetail, claimInventories,
} from './bitjita.mjs';
import { claimContainers, playerContainers, houseContainers } from './normalize.mjs';

/** Display order and labels for the origin groups. */
export const GROUPS = [
  { key: 'personal', label: 'Personal', hint: 'inventory, toolbelt, wallet' },
  { key: 'house', label: 'House', hint: 'chests inside your house' },
  { key: 'deployable', label: 'Wagons & mounts', hint: 'carts, wagons, birds' },
  { key: 'bank', label: 'Claim banks', hint: 'storage in claims you belong to' },
  { key: 'claim', label: 'Claim buildings', hint: 'buildings in the claim' },
];

/**
 * Which houses a player owns changes rarely, so the *list* is cached and only
 * the contents are refetched. That takes a house-owning player from three
 * requests per poll to two (DESIGN.md §10).
 */
const HOUSE_LIST_TTL_MS = 30 * 60 * 1000;
const houseListCache = new Map();

async function cachedHouseList(playerId) {
  const hit = houseListCache.get(playerId);
  if (hit && hit.expiresAt > Date.now()) return hit.houses;
  const houses = await playerHousing(playerId);
  const list = Array.isArray(houses) ? houses : [];
  houseListCache.set(playerId, { houses: list, expiresAt: Date.now() + HOUSE_LIST_TTL_MS });
  return list;
}

export function clearHouseListCache() {
  houseListCache.clear();
}

/** Every container a source exposes, flattened. */
export async function discoverContainers(source, { cacheHouseList = false } = {}) {
  if (source.type === 'claim') {
    const payload = await claimInventories(source.id);
    return claimContainers(payload);
  }

  const containers = [];
  const inv = await playerInventories(source.id);
  containers.push(...playerContainers(inv, source.id));

  // Housing is a separate fetch; /inventories never includes it.
  const houses = cacheHouseList ? await cachedHouseList(source.id) : await playerHousing(source.id);
  for (const house of Array.isArray(houses) ? houses : []) {
    const houseId = String(house.buildingEntityId ?? house.entityId);
    const detail = await houseDetail(source.id, houseId);
    if (!detail) continue;
    for (const c of houseContainers(detail)) {
      containers.push({ ...c, houseId, houseName: house.buildingName ?? null });
    }
  }
  return containers;
}

/** Bucket containers by origin, dropping empty groups, in GROUPS order. */
export function groupContainers(containers) {
  const byKey = new Map();
  for (const c of containers) {
    const list = byKey.get(c.origin) ?? [];
    byKey.set(c.origin, list);
    list.push(c);
  }
  return GROUPS
    .filter((g) => byKey.has(g.key))
    .map((g) => ({ ...g, containers: byKey.get(g.key) }));
}

/**
 * Discord caps a select menu at 25 options, and one character's house held 35
 * (DESIGN.md §7), so groups page.
 */
export const PAGE_SIZE = 25;

export function pageCount(total, size = PAGE_SIZE) {
  return Math.max(1, Math.ceil(total / size));
}

export function pageOf(items, page, size = PAGE_SIZE) {
  const pages = pageCount(items.length, size);
  const clamped = Math.min(Math.max(page, 0), pages - 1);
  return { page: clamped, pages, items: items.slice(clamped * size, clamped * size + size) };
}

/**
 * Merge one page's selection into the overall set.
 *
 * A select menu only reports the values on the page the user submitted, so
 * anything on that page that is now absent must be removed, while selections
 * made on other pages are left alone. Replacing the whole set would silently
 * discard them.
 */
export function mergeSelection(selected, pageIds, chosenIds) {
  const next = new Set(selected);
  for (const id of pageIds) next.delete(id);
  for (const id of chosenIds) next.add(id);
  return next;
}

/** A label a player recognises, kept inside Discord's 100-character cap. */
export function containerLabel(container) {
  const base = container.name ?? '(unnamed)';
  return base.length > 100 ? `${base.slice(0, 97)}…` : base;
}

/** Secondary line under a select option — where the container actually is. */
export function containerDescription(container) {
  const parts = [];
  if (container.origin === 'bank' && container.claimName) parts.push(container.claimName);
  if (container.origin === 'house' && container.houseName) parts.push(container.houseName);
  const filled = (container.pockets ?? []).filter((p) => p?.contents).length;
  parts.push(filled === 1 ? '1 stack' : `${filled} stacks`);
  const text = parts.join(' · ');
  return text.length > 100 ? `${text.slice(0, 97)}…` : text;
}
