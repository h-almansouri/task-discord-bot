/**
 * /setup, /config and /refresh — the channel, thresholds, and a manual redraw.
 */
import {
  SlashCommandBuilder, EmbedBuilder, MessageFlags, ChannelType, PermissionFlagsBits,
} from 'discord.js';
import { loadGuildConfig, updateGuildConfig, countContainers } from '../config/store.mjs';
import { runOnce, invalidate } from '../tracker/poll.mjs';
import { inTierRange } from '../tracker/thresholds.mjs';

export function configCommands(rulebook) {
  const travelerChoices = Object.keys(rulebook.travelers).sort().map((n) => ({ name: n, value: n }));

  return [
    {
      data: new SlashCommandBuilder()
        .setName('setup')
        .setDescription('Choose where the tracker message lives')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand((s) => s.setName('channel')
          .setDescription('Post the tracker in a channel')
          .addChannelOption((o) => o.setName('channel')
            .setDescription('Where to post')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true))),

      async run(interaction) {
        const channel = interaction.options.getChannel('channel');
        const me = interaction.guild.members.me;
        const perms = channel.permissionsFor(me);
        const needed = [
          [PermissionFlagsBits.ViewChannel, 'View Channel'],
          [PermissionFlagsBits.SendMessages, 'Send Messages'],
          [PermissionFlagsBits.EmbedLinks, 'Embed Links'],
        ].filter(([flag]) => !perms?.has(flag)).map(([, name]) => name);

        if (needed.length) {
          await interaction.reply({
            content: `I can't post in ${channel}. Missing: **${needed.join(', ')}**.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        // A new channel means the old message is orphaned — start fresh.
        await updateGuildConfig(interaction.guildId, (c) => ({
          ...c, channelId: channel.id, messageId: null,
        }));
        invalidate(interaction.guildId);

        await interaction.reply({
          content: `Tracker will post in ${channel}. Drawing it now…`,
          flags: MessageFlags.Ephemeral,
        });
        const r = await runOnce(interaction.client, interaction.guildId, { rulebook, force: true });
        if (r.status !== 'updated') {
          await interaction.followUp({
            content: `Couldn't draw the tracker (${r.status}).`,
            flags: MessageFlags.Ephemeral,
          });
        }
      },
    },

    {
      data: new SlashCommandBuilder()
        .setName('config')
        .setDescription('Thresholds and reminder settings')
        .addSubcommand((s) => s.setName('turnins')
          .setDescription('How many task turn-ins to keep stocked')
          .addIntegerOption((o) => o.setName('count')
            .setDescription('Number of turn-ins').setRequired(true).setMinValue(1).setMaxValue(999))
          .addStringOption((o) => o.setName('traveler')
            .setDescription('Apply to one traveler only').addChoices(...travelerChoices)))
        .addSubcommand((s) => s.setName('threshold')
          .setDescription('Set an absolute stock target for one material')
          .addStringOption((o) => o.setName('material')
            .setDescription('Material name').setRequired(true).setAutocomplete(true))
          .addIntegerOption((o) => o.setName('amount')
            .setDescription('How many to keep').setRequired(true).setMinValue(0)))
        .addSubcommand((s) => s.setName('show')
          .setDescription('Show the current settings')),

      async autocomplete(interaction) {
        const typed = interaction.options.getFocused().toLowerCase();
        const config = await loadGuildConfig(interaction.guildId);
        const tracked = Object.keys(config.travelers ?? {});
        const seen = new Map();
        for (const name of tracked.length ? tracked : Object.keys(rulebook.travelers)) {
          const traveler = rulebook.travelers[name];
          if (!traveler) continue;
          for (const m of traveler.materials) {
            if (!seen.has(m.key) && m.name.toLowerCase().includes(typed)) {
              seen.set(m.key, { name: `${m.name}${m.fixed ? '' : ' (needs a number)'}`.slice(0, 100), value: m.key });
            }
          }
        }
        await interaction.respond([...seen.values()].slice(0, 25));
      },

      async run(interaction) {
        if (!interaction.inGuild()) {
          await interaction.reply({ content: 'Use this in a server.', flags: MessageFlags.Ephemeral });
          return;
        }
        const sub = interaction.options.getSubcommand();
        if (sub === 'turnins') return setTurnIns(interaction);
        if (sub === 'threshold') return setThreshold(interaction, rulebook);
        if (sub === 'show') return showConfig(interaction, rulebook);
      },
    },

    {
      data: new SlashCommandBuilder()
        .setName('refresh')
        .setDescription('Redraw the tracker now'),
      async run(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const r = await runOnce(interaction.client, interaction.guildId, { rulebook, force: true });
        const messages = {
          updated: `Redrawn — ${r.totalShort} material(s) below target.`,
          'no-channel': 'No channel set. Use `/setup channel` first.',
          'channel-missing': 'The configured channel is gone. Set it again with `/setup channel`.',
          'send-failed': "I couldn't post there — check my permissions in that channel.",
        };
        await interaction.editReply(messages[r.status] ?? `Nothing to do (${r.status}).`);
      },
    },
  ];
}

async function setTurnIns(interaction) {
  const count = interaction.options.getInteger('count');
  const traveler = interaction.options.getString('traveler');

  await updateGuildConfig(interaction.guildId, (c) => (traveler
    ? { ...c, overrides: { ...c.overrides, [traveler]: { ...c.overrides?.[traveler], turnIns: count } } }
    : { ...c, turnIns: count }));
  invalidate(interaction.guildId);

  await interaction.reply({
    content: traveler
      ? `**${traveler}** now targets **${count}** turn-ins.`
      : `Default is now **${count}** turn-ins. Per-traveler overrides still apply.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function setThreshold(interaction, rulebook) {
  const key = interaction.options.getString('material');
  const amount = interaction.options.getInteger('amount');

  let material = null;
  for (const traveler of Object.values(rulebook.travelers)) {
    material = traveler.materials.find((m) => m.key === key);
    if (material) break;
  }
  if (!material) {
    await interaction.reply({
      content: `I don't recognise "${key}". Pick from the suggestions.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await updateGuildConfig(interaction.guildId, (c) => ({
    ...c, absolute: { ...c.absolute, [key]: amount },
  }));
  invalidate(interaction.guildId);

  await interaction.reply({
    content: `**${material.name}** target set to **${amount}**` +
      (material.fixed ? ' — this overrides the turn-in calculation for it.' : '.'),
    flags: MessageFlags.Ephemeral,
  });
}

async function showConfig(interaction, rulebook) {
  const c = await loadGuildConfig(interaction.guildId);
  const travelers = Object.entries(c.travelers ?? {});

  const absolutes = Object.entries(c.absolute ?? {}).map(([key, amount]) => {
    for (const t of Object.values(rulebook.travelers)) {
      const m = t.materials.find((x) => x.key === key);
      if (m) return `${m.name}: ${amount}`;
    }
    return `${key}: ${amount}`;
  });

  const materialCount = travelers.reduce((n, [name, s]) => {
    const t = rulebook.travelers[name];
    return n + (t ? t.materials.filter((m) => inTierRange(m, s.tiers)).length : 0);
  }, 0);

  const embed = new EmbedBuilder()
    .setTitle('Settings')
    .addFields(
      { name: 'Channel', value: c.channelId ? `<#${c.channelId}>` : '*not set — `/setup channel`*' },
      { name: 'Turn-ins', value: String(c.turnIns ?? 5), inline: true },
      { name: 'Containers', value: String(countContainers(c)), inline: true },
      { name: 'Materials watched', value: String(materialCount), inline: true },
      {
        name: 'Travelers',
        value: travelers.length
          ? travelers.map(([n, s]) => `${n} (T${s.tiers?.[0] ?? 1}–${s.tiers?.[1] ?? 10})` +
            (c.overrides?.[n]?.turnIns ? ` · ${c.overrides[n].turnIns} turn-ins` : '')).join('\n')
          : '*none — `/traveler add`*',
      },
      {
        name: 'Manual thresholds',
        value: absolutes.length ? absolutes.join('\n').slice(0, 1000) : '*none set*',
      },
    );

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
