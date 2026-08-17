/**
 * The polling loop: fetch stock once, then keep one message per traveler
 * up to date.
 *
 * Each traveler owns a message, optionally in its own channel, so people can
 * follow the travelers they care about and mute the rest. Splitting costs extra
 * Discord edits but not extra bitjita calls — stock is fetched once per pass
 * regardless (DESIGN.md §9).
 */
import { fetchTrackedStock } from '../stock/fetch.mjs';
import { computeShortfalls } from './shortfall.mjs';
import { renderTraveler, renderEmpty, travelerHash } from './render.mjs';
import { loadGuildConfig, updateGuildConfig, listGuildConfigs } from '../config/store.mjs';

export const DEFAULT_INTERVAL_MS = 20_000;

const lastHash = new Map();
const hashKey = (guildId, traveler) => `${guildId}:${traveler}`;

/** Force the next pass to redraw, for one traveler or the whole guild. */
export function invalidate(guildId, travelerName = null) {
  if (travelerName) {
    lastHash.delete(hashKey(guildId, travelerName));
    return;
  }
  for (const key of [...lastHash.keys()]) {
    if (key.startsWith(`${guildId}:`)) lastHash.delete(key);
  }
}

/** Where a traveler's message belongs: its own channel, else the guild default. */
export function channelForTraveler(config, name) {
  return config.travelers?.[name]?.channelId ?? config.channelId ?? null;
}

async function publish(client, guildId, name, channelId, payload, { force }) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return { status: 'channel-missing' };

  const config = await loadGuildConfig(guildId);
  const messageId = config.travelers?.[name]?.messageId;

  if (messageId) {
    const edited = await channel.messages.fetch(messageId)
      .then((m) => m.edit(payload))
      .catch(() => null);
    if (edited) return { status: force ? 'updated' : 'updated', messageId: edited.id };
  }

  const sent = await channel.send(payload).catch(() => null);
  if (!sent) return { status: 'send-failed' };

  await updateGuildConfig(guildId, (c) => ({
    ...c,
    travelers: {
      ...c.travelers,
      [name]: { ...c.travelers?.[name], messageId: sent.id },
    },
  }));
  return { status: 'created', messageId: sent.id };
}

/**
 * Run one pass for a guild. Returns what happened, which makes it testable and
 * lets /refresh reuse exactly the same path as the timer.
 */
export async function runOnce(client, guildId, { rulebook, force = false } = {}) {
  const config = await loadGuildConfig(guildId);
  const tracked = Object.keys(config.travelers ?? {});
  if (!tracked.length) return { status: 'no-travelers' };
  if (!config.channelId && !tracked.some((n) => config.travelers[n].channelId)) {
    return { status: 'no-channel' };
  }

  const { totals, missing, errors, containerCount } = await fetchTrackedStock(config.storages);
  const result = computeShortfalls({ rulebook, config, stock: totals });
  const byName = new Map(result.travelers.map((t) => [t.name, t]));

  // A data problem is worth surfacing on every message rather than nowhere.
  const notes = [];
  if (missing.length) notes.push(`${missing.length} container(s) not visible`);
  if (errors.length) notes.push(`${errors.length} source(s) failed to load`);
  const noteSuffix = notes.length ? ` · ⚠️ ${notes.join(' · ')}` : '';

  let updated = 0, unchanged = 0;
  const problems = [];

  for (const name of tracked) {
    const channelId = channelForTraveler(config, name);
    if (!channelId) { problems.push(`${name}: no channel`); continue; }

    const traveler = byName.get(name);
    const hash = (traveler ? travelerHash(traveler) : `empty:${name}`) + noteSuffix;
    const key = hashKey(guildId, name);

    if (!force && lastHash.get(key) === hash) { unchanged++; continue; }

    const payload = traveler
      ? renderTraveler(traveler, { updatedAt: Date.now(), storageCount: containerCount })
      : renderEmpty(name);
    if (noteSuffix && payload.embeds[0].footer) {
      payload.embeds[0].footer.text += noteSuffix;
    }

    const r = await publish(client, guildId, name, channelId, payload, { force });
    if (r.status === 'updated' || r.status === 'created') {
      lastHash.set(key, hash);
      updated++;
    } else {
      problems.push(`${name}: ${r.status}`);
    }
  }

  return {
    status: problems.length && !updated ? 'failed' : 'ok',
    updated,
    unchanged,
    problems,
    totalShort: result.totalShort,
  };
}

/** Remove a traveler's message, used when it stops being tracked. */
export async function removeTravelerMessage(client, guildId, name) {
  const config = await loadGuildConfig(guildId);
  const entry = config.travelers?.[name];
  const channelId = entry?.channelId ?? config.channelId;
  if (!entry?.messageId || !channelId) return false;

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return false;
  const deleted = await channel.messages.fetch(entry.messageId)
    .then((m) => m.delete())
    .then(() => true)
    .catch(() => false);
  invalidate(guildId, name);
  return deleted;
}

/** Start the timer across every guild that has a config on disk. */
export function startTracker(client, { rulebook, intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  let running = false;

  const pass = async () => {
    if (running) return;         // never overlap passes
    running = true;
    try {
      for (const guildId of await listGuildConfigs()) {
        if (!client.guilds.cache.has(guildId)) continue;
        try {
          const r = await runOnce(client, guildId, { rulebook });
          if (r.updated) console.log(`[tracker] ${guildId}: redrew ${r.updated}, ${r.totalShort} short`);
          if (r.problems?.length) console.warn(`[tracker] ${guildId}: ${r.problems.join('; ')}`);
        } catch (err) {
          console.error(`[tracker] ${guildId} failed:`, err.message);
        }
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(pass, intervalMs);
  timer.unref?.();
  pass();
  return () => clearInterval(timer);
}
