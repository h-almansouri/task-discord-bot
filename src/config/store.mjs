/**
 * Per-guild configuration, stored as JSON under config/ (gitignored).
 *
 * A flat file is deliberate: one guild's config is small, and the whole thing
 * is rewritten on change. SQLite only becomes worthwhile if this bot is ever
 * run for many guilds at once (DESIGN.md §6).
 */
import { readFile, writeFile, rename, mkdir, readdir, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Where guild config lives.
 *
 * Defaults to config/ beside the source, which is right for running locally.
 * Hosted, it must point at persistent storage: most platforms wipe the
 * filesystem on every deploy and restart, which would silently discard every
 * guild's channels, travelers and thresholds. On Render that means a mounted
 * disk, e.g. CONFIG_DIR=/data/config.
 */
const DIR = process.env.CONFIG_DIR
  ? path.resolve(process.env.CONFIG_DIR)
  : fileURLToPath(new URL('../../config/', import.meta.url));

export function defaultConfig() {
  return {
    channelId: null,
    messageId: null,
    // channelId null means the reminder pings in the guild default channel.
    // announcedFor is the rotation (micros string) last pinged, persisted so a
    // restart cannot re-ping the same reroll.
    reminder: { roleId: null, hoursBefore: 24, channelId: null, announcedFor: null },
    storages: [],
    travelers: {},
    turnIns: 5,
    // Turn-in counts for tier ranges, e.g. 250 for T1-T4. A band holds turn-ins
    // rather than an amount, so what it costs varies by material.
    tierBands: [],
    // Blanket target for materials asked for at varying quantities, where
    // turn-in maths does not apply. null means "ask me" rather than guess.
    variableDefault: null,
    overrides: {},
    absolute: {},
  };
}

const fileFor = (guildId) => path.join(DIR, `${guildId}.json`);

export async function loadGuildConfig(guildId) {
  try {
    const parsed = JSON.parse(await readFile(fileFor(guildId), 'utf8'));
    return { ...defaultConfig(), ...parsed };
  } catch (err) {
    if (err.code === 'ENOENT') return defaultConfig();
    throw err;
  }
}

/** Write via a temp file and rename, so a crash mid-write can't truncate config. */
export async function saveGuildConfig(guildId, config) {
  await mkdir(DIR, { recursive: true });
  const target = fileFor(guildId);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(config, null, 2) + '\n');
  await rename(tmp, target);
  return config;
}

/**
 * Read-modify-write. Serialised per guild so two interactions arriving together
 * cannot clobber each other — Discord components make that easy to trigger.
 */
const queues = new Map();
export function updateGuildConfig(guildId, mutate) {
  const prior = queues.get(guildId) ?? Promise.resolve();
  const next = prior.then(async () => {
    const config = await loadGuildConfig(guildId);
    const updated = (await mutate(config)) ?? config;
    return saveGuildConfig(guildId, updated);
  });
  // Keep the chain alive even if one link rejects.
  queues.set(guildId, next.catch(() => {}));
  return next;
}

export async function listGuildConfigs() {
  try {
    const files = await readdir(DIR);
    return files.filter((f) => f.endsWith('.json') && f !== 'example.json')
      .map((f) => f.replace(/\.json$/, ''));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

export async function deleteGuildConfig(guildId) {
  try {
    await unlink(fileFor(guildId));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

// --- storage helpers -------------------------------------------------------

/** Total containers tracked across all sources. */
export function countContainers(config) {
  return (config.storages ?? []).reduce((n, s) => n + (s.containers?.length ?? 0), 0);
}

/**
 * Replace the tracked containers for one source. An empty list drops the source
 * entirely rather than leaving a stub that tracks nothing.
 */
export function setStorageContainers(config, source, containers) {
  const storages = (config.storages ?? []).filter(
    (s) => !(s.source.type === source.type && String(s.source.id) === String(source.id)),
  );
  if (containers.length) {
    storages.push({
      source: { type: source.type, id: String(source.id), name: source.name },
      containers: containers.map((c) => ({
        id: String(c.id),
        name: c.name,
        origin: c.origin,
      })),
    });
  }
  return { ...config, storages };
}

/**
 * Change a traveler's tier range, keeping everything else about it.
 *
 * Written as a merge rather than a replacement on purpose: a traveler entry also
 * holds its channel, the id of the message being edited in place, and any
 * ignored families. Replacing the object silently discarded all three.
 */
export function setTravelerTiers(config, name, tiers) {
  return {
    ...config,
    travelers: {
      ...config.travelers,
      [name]: { ...config.travelers?.[name], tiers },
    },
  };
}

export function findStorage(config, source) {
  return (config.storages ?? []).find(
    (s) => s.source.type === source.type && String(s.source.id) === String(source.id),
  );
}

// --- channel moves ---------------------------------------------------------
//
// Moving a channel strands the message being edited in place, and a stranded
// tracker keeps its last numbers forever — which reads as the bot showing
// wrong data, not as a leftover. So a move reports the stranded messages as
// `orphans` for the caller to delete, and a "move" to the same channel keeps
// every message id, because there is nothing to strand.

/** Point the guild default at a channel. Travelers with their own channel keep it. */
export function setDefaultChannel(config, channelId) {
  if (config.channelId === channelId) return { config: { ...config }, orphans: [] };

  const orphans = [];
  const travelers = Object.fromEntries(
    Object.entries(config.travelers ?? {}).map(([name, t]) => {
      if (t.channelId || !t.messageId) return [name, t];
      if (config.channelId) orphans.push({ channelId: config.channelId, messageId: t.messageId });
      return [name, { ...t, messageId: null }];
    }),
  );
  return { config: { ...config, channelId, travelers }, orphans };
}

/** Give one traveler its own channel. */
export function setTravelerChannel(config, name, channelId) {
  const t = config.travelers?.[name] ?? {};
  const current = t.channelId ?? config.channelId;

  // Same place the message already lives — pin the traveler there and keep it.
  if (current === channelId) {
    return {
      config: { ...config, travelers: { ...config.travelers, [name]: { ...t, channelId } } },
      orphans: [],
    };
  }
  const orphans = t.messageId && current ? [{ channelId: current, messageId: t.messageId }] : [];
  return {
    config: {
      ...config,
      travelers: { ...config.travelers, [name]: { ...t, channelId, messageId: null } },
    },
    orphans,
  };
}
