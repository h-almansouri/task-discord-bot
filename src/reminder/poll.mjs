/**
 * The reminder loop: learn the next reroll from a relay a few times a day,
 * check every minute whether any guild's ping window has opened.
 *
 * Two cadences on purpose. The relay holds the *schedule*, which moves once a
 * week, so reading it four times a day is plenty and keeps load off the
 * volunteer relays; the *ping* should land within a minute of the window
 * opening, which a local clock check gives for free (DESIGN.md §9).
 */
import { readTables } from '../relay/client.mjs';
import { rotationFromRows, shouldAnnounce, renderReminder } from './rotation.mjs';
import { listGuildConfigs, loadGuildConfig, updateGuildConfig } from '../config/store.mjs';

export const TIMER_TABLE = 'traveler_task_loop_timer';
export const REFRESH_MS = 6 * 3_600_000;
export const RETRY_MS = 15 * 60_000;
export const CHECK_MS = 60_000;

let cached = null;

/** The last successfully read rotation, for commands to echo. */
export function currentRotation() {
  return cached;
}

export async function fetchRotation({ onLog = () => {} } = {}) {
  const { tables } = await readTables([TIMER_TABLE], { onLog });
  return rotationFromRows(tables[TIMER_TABLE]);
}

/**
 * One guild, one decision. A failed send does NOT mark the rotation announced,
 * so the next check retries it — the failure mode is a late ping, never a
 * silently swallowed one.
 */
export async function announceForGuild(client, guildId, rotation, { nowMs = Date.now() } = {}) {
  const config = await loadGuildConfig(guildId);
  const decision = shouldAnnounce({ rotation, reminder: config.reminder, nowMs });
  if (!decision.announce) return { status: decision.reason };

  const channelId = config.reminder?.channelId ?? config.channelId;
  if (!channelId) return { status: 'no-channel' };
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return { status: 'channel-missing' };

  const sent = await channel.send(renderReminder(rotation, config.reminder)).catch(() => null);
  if (!sent) return { status: 'send-failed' };

  await updateGuildConfig(guildId, (c) => ({
    ...c,
    reminder: { ...c.reminder, announcedFor: rotation.micros },
  }));
  return { status: 'announced' };
}

export function startReminder(client, { refreshMs = REFRESH_MS, checkMs = CHECK_MS } = {}) {
  let stopped = false;
  let refreshTimer = null;
  let checking = false;
  const lastStatus = new Map();

  const refresh = async () => {
    let delay = refreshMs;
    try {
      const rotation = await fetchRotation();
      if (rotation) {
        if (rotation.micros !== cached?.micros) {
          console.log(`[reminder] next rotation ${new Date(rotation.atMs).toISOString()}`);
        }
        cached = rotation;
      } else {
        // Keep the previous value — a known schedule beats none at all.
        console.warn('[reminder] timer read returned no usable rotation');
        delay = RETRY_MS;
      }
    } catch (err) {
      console.warn(`[reminder] timer read failed: ${err.message}`);
      delay = RETRY_MS;
    }
    if (!stopped) {
      refreshTimer = setTimeout(refresh, delay);
      refreshTimer.unref?.();
    }
  };

  const check = async () => {
    if (checking || !cached) return;
    checking = true;
    try {
      for (const guildId of await listGuildConfigs()) {
        if (!client.guilds.cache.has(guildId)) continue;
        try {
          const { status } = await announceForGuild(client, guildId, cached);
          if (status === 'announced') {
            console.log(`[reminder] ${guildId}: pinged for rotation ${new Date(cached.atMs).toISOString()}`);
          } else if (
            ['no-channel', 'channel-missing', 'send-failed'].includes(status) &&
            lastStatus.get(guildId) !== status
          ) {
            // Only on transition — a broken channel should not log every minute.
            console.warn(`[reminder] ${guildId}: ${status}`);
          }
          lastStatus.set(guildId, status);
        } catch (err) {
          console.error(`[reminder] ${guildId} failed:`, err.message);
        }
      }
    } finally {
      checking = false;
    }
  };

  const checkTimer = setInterval(check, checkMs);
  checkTimer.unref?.();
  refresh();

  return () => {
    stopped = true;
    clearTimeout(refreshTimer);
    clearInterval(checkTimer);
  };
}
