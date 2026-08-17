/**
 * bitjita REST client (DESIGN.md §3).
 *
 * Public, no auth. Rate limit is 250 req/min; they ask for an identifying
 * header, so send one. Claim and player ids are region-agnostic — no region
 * parameter is ever needed (§4.8).
 */
const BASE = 'https://bitjita.com';

const HEADERS = {
  'User-Agent': 'bitcraft-traveler-supply-bot (github.com/h-almansouri/task-discord-bot)',
  'x-app-identifier': 'bitcraft-traveler-supply-bot',
};

export class BitjitaError extends Error {
  constructor(message, { status, path } = {}) {
    super(message);
    this.name = 'BitjitaError';
    this.status = status;
    this.path = path;
  }
}

async function get(path, { timeoutMs = 20_000 } = {}) {
  const res = await fetch(BASE + path, {
    headers: HEADERS,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 404) return null;
  if (res.status === 429) {
    throw new BitjitaError('Rate limited by bitjita — try again shortly.', { status: 429, path });
  }
  if (!res.ok) {
    throw new BitjitaError(`bitjita returned ${res.status}`, { status: res.status, path });
  }
  return res.json();
}

/** Player name search. bitjita requires at least 2 characters. */
export async function searchPlayers(query) {
  if (String(query).trim().length < 2) return [];
  const data = await get(`/api/players?q=${encodeURIComponent(query)}`);
  return (data?.players ?? []).map((p) => ({
    type: 'player',
    id: String(p.entityId),
    name: p.username,
    signedIn: Boolean(p.signedIn),
  }));
}

/** Claim name search. */
export async function searchClaims(query) {
  if (String(query).trim().length < 2) return [];
  const data = await get(`/api/claims?q=${encodeURIComponent(query)}`);
  return (data?.claims ?? data?.data ?? []).map((c) => ({
    type: 'claim',
    id: String(c.entityId),
    name: c.name,
    regionName: c.regionName ?? null,
  }));
}

/**
 * Look a name up as both a player and a claim. An exact case-insensitive match
 * wins outright; otherwise the caller disambiguates.
 */
export async function resolveSource(query) {
  const [players, claims] = await Promise.all([
    searchPlayers(query).catch(() => []),
    searchClaims(query).catch(() => []),
  ]);
  const all = [...players, ...claims];
  const wanted = String(query).trim().toLowerCase();
  const exact = all.filter((c) => c.name?.toLowerCase() === wanted);
  return { candidates: all, exact };
}

export const playerInventories = (id) => get(`/api/players/${id}/inventories`);
export const playerHousing = (id) => get(`/api/players/${id}/housing`);
export const houseDetail = (playerId, houseId) => get(`/api/players/${playerId}/housing/${houseId}`);
export const claimInventories = (id) => get(`/api/claims/${id}/inventories`);
