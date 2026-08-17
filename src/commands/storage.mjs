/**
 * /storage — pick which containers count as traveler supply.
 *
 * One character can expose 54 containers across personal slots, deployables,
 * claim banks and house chests (DESIGN.md §4.11), so nothing is tracked by
 * default. The picker asks for an origin group first, then lists within it,
 * paging when a group exceeds Discord's 25-option cap (§7).
 */
import { randomUUID } from 'node:crypto';
import {
  SlashCommandBuilder, EmbedBuilder, MessageFlags,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
} from 'discord.js';
import { resolveSource, BitjitaError } from '../stock/bitjita.mjs';
import {
  discoverContainers, groupContainers, pageOf, mergeSelection,
  containerLabel, containerDescription, PAGE_SIZE,
} from '../stock/discover.mjs';
import {
  loadGuildConfig, updateGuildConfig, setStorageContainers, findStorage, countContainers,
} from '../config/store.mjs';

export const PREFIX = 'st';

/** Discord invalidates an interaction token after 15 minutes. */
const SESSION_TTL_MS = 14 * 60 * 1000;
const sessions = new Map();

function newSession(data) {
  const id = randomUUID().slice(0, 8);
  sessions.set(id, { id, expiresAt: Date.now() + SESSION_TTL_MS, ...data });
  return sessions.get(id);
}

function getSession(id, interaction) {
  const s = sessions.get(id);
  if (!s || s.expiresAt < Date.now()) {
    sessions.delete(id);
    return null;
  }
  // Components are visible only to the invoking user, but check anyway.
  if (s.userId !== interaction.user.id) return null;
  return s;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (s.expiresAt < now) sessions.delete(id);
}, 60_000).unref?.();

const cid = (...parts) => [PREFIX, ...parts].join('|');

// --- rendering -------------------------------------------------------------

function groupStep(session) {
  const { source, groups, selected } = session;
  const total = groups.reduce((n, g) => n + g.containers.length, 0);

  const embed = new EmbedBuilder()
    .setTitle(`Tracking ${source.name}`)
    .setDescription(
      `${total} containers found. Pick a group to choose from — your selections ` +
      'add up across groups.\n\n' +
      groups.map((g) => {
        const chosen = g.containers.filter((c) => selected.has(c.id)).length;
        return `**${g.label}** — ${g.containers.length} available` +
          (chosen ? ` · **${chosen} selected**` : '');
      }).join('\n'),
    )
    .setFooter({ text: `${selected.size} container(s) selected · Save to apply` });

  const menu = new StringSelectMenuBuilder()
    .setCustomId(cid('grp', session.id))
    .setPlaceholder('Choose a group…')
    .addOptions(groups.map((g) => {
      const chosen = g.containers.filter((c) => selected.has(c.id)).length;
      return new StringSelectMenuOptionBuilder()
        .setLabel(`${g.label} (${g.containers.length})`)
        .setValue(g.key)
        .setDescription(chosen ? `${chosen} selected · ${g.hint}`.slice(0, 100) : g.hint.slice(0, 100));
    }));

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(cid('save', session.id))
      .setLabel(selected.size ? `Save ${selected.size}` : 'Save (track nothing)')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(cid('cancel', session.id))
      .setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu), buttons] };
}

function pickStep(session) {
  const group = session.groups.find((g) => g.key === session.group);
  const { page, pages, items } = pageOf(group.containers, session.page);
  session.page = page;

  const embed = new EmbedBuilder()
    .setTitle(`${session.source.name} · ${group.label}`)
    .setDescription(
      `Select every container that holds traveler supplies.` +
      (pages > 1 ? `\n\nPage **${page + 1}** of ${pages} — selections on other pages are kept.` : ''),
    )
    .setFooter({ text: `${session.selected.size} selected overall` });

  const menu = new StringSelectMenuBuilder()
    .setCustomId(cid('pick', session.id, String(page)))
    .setPlaceholder(`Containers ${page * PAGE_SIZE + 1}–${page * PAGE_SIZE + items.length}`)
    .setMinValues(0)
    .setMaxValues(items.length)
    .addOptions(items.map((c) => new StringSelectMenuOptionBuilder()
      .setLabel(containerLabel(c))
      .setValue(c.id)
      .setDescription(containerDescription(c))
      .setDefault(session.selected.has(c.id))));

  const nav = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(cid('page', session.id, String(page - 1)))
      .setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(cid('page', session.id, String(page + 1)))
      .setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1),
    new ButtonBuilder().setCustomId(cid('back', session.id))
      .setLabel('Back to groups').setStyle(ButtonStyle.Primary),
  );

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu), nav] };
}

// --- command ---------------------------------------------------------------

export function storageCommands() {
  return [{
    data: new SlashCommandBuilder()
      .setName('storage')
      .setDescription('Choose which containers count as traveler supply')
      .addSubcommand((s) => s.setName('add')
        .setDescription('Track containers from a player or claim')
        .addStringOption((o) => o.setName('name')
          .setDescription('Player or claim name')
          .setRequired(true)
          .setMinLength(2)))
      .addSubcommand((s) => s.setName('list')
        .setDescription('Show what is currently tracked'))
      .addSubcommand((s) => s.setName('remove')
        .setDescription('Stop tracking a source')
        .addIntegerOption((o) => o.setName('number')
          .setDescription('Number from /storage list')
          .setRequired(true)
          .setMinValue(1))),

    async run(interaction) {
      if (!interaction.inGuild()) {
        await interaction.reply({ content: 'Use this in a server, not a DM.', flags: MessageFlags.Ephemeral });
        return;
      }
      const sub = interaction.options.getSubcommand();
      if (sub === 'add') return runAdd(interaction);
      if (sub === 'list') return runList(interaction);
      if (sub === 'remove') return runRemove(interaction);
    },
  }];
}

async function runAdd(interaction) {
  const query = interaction.options.getString('name');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let candidates, exact;
  try {
    ({ candidates, exact } = await resolveSource(query));
  } catch (err) {
    await interaction.editReply(bitjitaMessage(err));
    return;
  }

  if (!candidates.length) {
    await interaction.editReply(`Nothing called "${query}" — no player or claim matched.`);
    return;
  }

  const source = exact.length === 1 ? exact[0]
    : candidates.length === 1 ? candidates[0]
      : null;

  if (!source) {
    const shortlist = candidates.slice(0, 25);
    const session = newSession({
      guildId: interaction.guildId, userId: interaction.user.id, candidates: shortlist,
    });
    const menu = new StringSelectMenuBuilder()
      .setCustomId(cid('src', session.id))
      .setPlaceholder('Which one?')
      .addOptions(shortlist.map((c, i) => new StringSelectMenuOptionBuilder()
        .setLabel(`${c.name}`.slice(0, 100))
        .setValue(String(i))
        .setDescription(c.type === 'player'
          ? `player${c.signedIn ? ' · online' : ''}`
          : `claim${c.regionName ? ` · ${c.regionName}` : ''}`)));
    await interaction.editReply({
      content: `${candidates.length} matches for "${query}". Pick one:`,
      components: [new ActionRowBuilder().addComponents(menu)],
    });
    return;
  }

  await beginPicker(interaction, source);
}

async function beginPicker(interaction, source) {
  await interaction.editReply({
    content: `Fetching containers for **${source.name}**…`, components: [], embeds: [],
  });

  let containers;
  try {
    containers = await discoverContainers(source);
  } catch (err) {
    await interaction.editReply(bitjitaMessage(err));
    return;
  }

  if (!containers.length) {
    await interaction.editReply({
      content: `**${source.name}** has no containers the API exposes.`, components: [],
    });
    return;
  }

  const config = await loadGuildConfig(interaction.guildId);
  const already = findStorage(config, source);
  const known = new Set(containers.map((c) => c.id));
  const selected = new Set((already?.containers ?? []).map((c) => c.id).filter((id) => known.has(id)));

  const session = newSession({
    guildId: interaction.guildId,
    userId: interaction.user.id,
    source,
    containers,
    groups: groupContainers(containers),
    selected,
    group: null,
    page: 0,
  });

  await interaction.editReply({ content: '', ...groupStep(session) });
}

async function runList(interaction) {
  const config = await loadGuildConfig(interaction.guildId);
  if (!config.storages?.length) {
    await interaction.reply({
      content: 'Nothing tracked yet. Add some with `/storage add`.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const lines = config.storages.map((s, i) => {
    const byOrigin = new Map();
    for (const c of s.containers) byOrigin.set(c.origin, (byOrigin.get(c.origin) ?? 0) + 1);
    const summary = [...byOrigin].map(([o, n]) => `${n} ${o}`).join(', ');
    const names = s.containers.map((c) => c.name).join(', ');
    return `**${i + 1}. ${s.source.name}** *(${s.source.type})* — ${s.containers.length} container(s): ${summary}\n` +
      `   ${names.length > 300 ? `${names.slice(0, 297)}…` : names}`;
  });

  const embed = new EmbedBuilder()
    .setTitle('Tracked storage')
    .setDescription(lines.join('\n'))
    .setFooter({ text: `${countContainers(config)} container(s) across ${config.storages.length} source(s)` });

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function runRemove(interaction) {
  const n = interaction.options.getInteger('number');
  const config = await loadGuildConfig(interaction.guildId);
  const target = config.storages?.[n - 1];
  if (!target) {
    await interaction.reply({
      content: `No source number ${n}. Check \`/storage list\`.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await updateGuildConfig(interaction.guildId, (c) => ({
    ...c,
    storages: c.storages.filter((_, i) => i !== n - 1),
  }));
  await interaction.reply({
    content: `Stopped tracking **${target.source.name}** (${target.containers.length} container(s)).`,
    flags: MessageFlags.Ephemeral,
  });
}

// --- component routing -----------------------------------------------------

export async function handleComponent(interaction) {
  const [, action, sessionId, extra] = interaction.customId.split('|');
  const session = getSession(sessionId, interaction);
  if (!session) {
    await interaction.update({
      content: 'That picker expired — run `/storage add` again.',
      embeds: [], components: [],
    }).catch(() => {});
    return;
  }

  switch (action) {
    case 'src': {
      const picked = session.candidates[Number(interaction.values[0])];
      sessions.delete(session.id);
      await interaction.update({ content: `Loading **${picked.name}**…`, components: [] });
      await beginPicker(interaction, picked);
      return;
    }
    case 'grp': {
      session.group = interaction.values[0];
      session.page = 0;
      await interaction.update(pickStep(session));
      return;
    }
    case 'pick': {
      const group = session.groups.find((g) => g.key === session.group);
      const { items } = pageOf(group.containers, Number(extra));
      session.selected = mergeSelection(
        session.selected,
        items.map((c) => c.id),
        interaction.values,
      );
      await interaction.update(pickStep(session));
      return;
    }
    case 'page': {
      session.page = Number(extra);
      await interaction.update(pickStep(session));
      return;
    }
    case 'back': {
      session.group = null;
      await interaction.update(groupStep(session));
      return;
    }
    case 'save': {
      const chosen = session.containers.filter((c) => session.selected.has(c.id));
      await updateGuildConfig(session.guildId, (c) => setStorageContainers(c, session.source, chosen));
      sessions.delete(session.id);
      const summary = chosen.length
        ? `Now tracking **${chosen.length}** container(s) from **${session.source.name}**:\n` +
          chosen.map((c) => `• ${c.name} *(${c.origin})*`).join('\n').slice(0, 3500)
        : `Stopped tracking **${session.source.name}** — nothing selected.`;
      await interaction.update({ content: summary, embeds: [], components: [] });
      return;
    }
    case 'cancel': {
      sessions.delete(session.id);
      await interaction.update({ content: 'Cancelled — nothing changed.', embeds: [], components: [] });
      return;
    }
    default:
      await interaction.deferUpdate().catch(() => {});
  }
}

function bitjitaMessage(err) {
  if (err instanceof BitjitaError && err.status === 429) {
    return 'bitjita is rate-limiting us right now — give it a minute and try again.';
  }
  if (err?.name === 'TimeoutError') {
    return 'bitjita did not respond in time. It may be having a moment; try again shortly.';
  }
  return `Could not reach bitjita: ${err?.message ?? 'unknown error'}`;
}
