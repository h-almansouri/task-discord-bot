/**
 * The polling loop: fetch stock, compare against targets, edit one message.
 *
 * Polls every 20s, comfortably inside bitjita's own 5s cache, and only calls
 * edit() when the rendered content actually changed. Without that guard an
 * active hauling session would edit three times a minute for hours; with it a
 * quiet claim costs zero Discord calls (DESIGN.md §9).
 */
import { fetchTrackedStock } from '../stock/fetch.mjs';
import { computeShortfalls } from './shortfall.mjs';
import { renderTracker, contentHash } from './render.mjs';
import { loadGuildConfig, updateGuildConfig, listGuildConfigs } from '../config/store.mjs';

export const DEFAULT_INTERVAL_MS = 20_000;

const lastHash = new Map();

/** Force the next pass to redraw even if the numbers are unchanged. */
export function invalidate(guildId) {
  lastHash.delete(guildId);
}

/**
 * Run one pass for a guild. Returns what happened, which makes it testable and
 * lets /refresh reuse exactly the same path as the timer.
 */
export async function runOnce(client, guildId, { rulebook, force = false } = {}) {
  const config = await loadGuildConfig(guildId);
  if (!config.channelId) return { status: 'no-channel' };

  const { totals, missing, errors, containerCount } = await fetchTrackedStock(config.storages);
  const result = computeShortfalls({ rulebook, config, stock: totals });
  const hash = contentHash(result) + `|${missing.length}|${errors.length}`;

  if (!force && lastHash.get(guildId) === hash) {
    return { status: 'unchanged', totalShort: result.totalShort };
  }

  const message = renderTracker(result, { updatedAt: Date.now(), storageCount: containerCount });

  if (missing.length || errors.length) {
    const notes = [];
    if (missing.length) {
      notes.push(`${missing.length} tracked container(s) not currently visible: ` +
        missing.slice(0, 5).map((m) => `${m.name} (${m.source})`).join(', '));
    }
    if (errors.length) {
      notes.push(`${errors.length} source(s) failed to load: ` +
        errors.slice(0, 3).map((e) => `${e.source} — ${e.message}`).join('; '));
    }
    message.embeds.push({
      title: 'Notes',
      description: notes.join('\n').slice(0, 4000),
      color: 0xf0ad4e,
    });
  }

  const channel = await client.channels.fetch(config.channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return { status: 'channel-missing' };

  let posted = null;
  if (config.messageId) {
    posted = await channel.messages.fetch(config.messageId)
      .then((m) => m.edit(message))
      .catch(() => null);
  }
  if (!posted) {
    posted = await channel.send(message).catch(() => null);
    if (!posted) return { status: 'send-failed' };
    await updateGuildConfig(guildId, (c) => ({ ...c, messageId: posted.id }));
  }

  lastHash.set(guildId, hash);
  return { status: 'updated', totalShort: result.totalShort, messageId: posted.id };
}

/** Start the timer across every guild that has a config on disk. */
export function startTracker(client, { rulebook, intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  let running = false;

  const pass = async () => {
    if (running) return;         // never overlap passes
    running = true;
    try {
      const guildIds = await listGuildConfigs();
      for (const guildId of guildIds) {
        if (!client.guilds.cache.has(guildId)) continue;
        try {
          const r = await runOnce(client, guildId, { rulebook });
          if (r.status === 'updated') {
            console.log(`[tracker] ${guildId}: redrew, ${r.totalShort} short`);
          } else if (r.status !== 'unchanged' && r.status !== 'no-channel') {
            console.warn(`[tracker] ${guildId}: ${r.status}`);
          }
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
