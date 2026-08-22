/**
 * /setup, /config and /refresh — the channel, thresholds, and a manual redraw.
 */
import {
  SlashCommandBuilder, EmbedBuilder, MessageFlags, ChannelType, PermissionFlagsBits,
} from 'discord.js';
import {
  loadGuildConfig, updateGuildConfig, countContainers, setDefaultChannel, setTravelerChannel,
} from '../config/store.mjs';
import { runOnce, invalidate } from '../tracker/poll.mjs';
import { inTierRange } from '../tracker/thresholds.mjs';
import { sanitizeHours } from '../reminder/rotation.mjs';
import { currentRotation } from '../reminder/poll.mjs';

export function configCommands(rulebook) {
  const travelerChoices = Object.keys(rulebook.travelers).sort().map((n) => ({ name: n, value: n }));

  return [
    {
      data: new SlashCommandBuilder()
        .setName('setup')
        .setDescription('Choose where the tracker message lives')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand((s) => s.setName('channel')
          .setDescription('Where the tracker posts — a default, or one traveler’s own channel')
          .addChannelOption((o) => o.setName('channel')
            .setDescription('Where to post')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true))
          .addStringOption((o) => o.setName('traveler')
            .setDescription('Give just this traveler its own channel')
            .addChoices(...travelerChoices))),

      async run(interaction) {
        const channel = interaction.options.getChannel('channel');
        const traveler = interaction.options.getString('traveler');
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

        // A real move strands the messages being edited in place; delete them
        // rather than leave them frozen at their last numbers. Re-running with
        // the same channel strands nothing and keeps every message.
        let orphans = [];
        await updateGuildConfig(interaction.guildId, (c) => {
          const moved = traveler
            ? setTravelerChannel(c, traveler, channel.id)
            : setDefaultChannel(c, channel.id);
          orphans = moved.orphans;
          return moved.config;
        });
        for (const o of orphans) {
          const ch = await interaction.client.channels.fetch(o.channelId).catch(() => null);
          if (ch?.isTextBased?.()) {
            await ch.messages.fetch(o.messageId).then((m) => m.delete()).catch(() => {});
          }
        }
        invalidate(interaction.guildId);

        await interaction.reply({
          content: traveler
            ? `**${traveler}** will post in ${channel}. Drawing it now…`
            : `Tracker will post in ${channel} unless a traveler has its own. Drawing now…`,
          flags: MessageFlags.Ephemeral,
        });

        const r = await runOnce(interaction.client, interaction.guildId, { rulebook, force: true });
        if (r.status === 'no-travelers') {
          await interaction.followUp({
            content: 'No travelers tracked yet — add one with `/traveler add`.',
            flags: MessageFlags.Ephemeral,
          });
        } else if (r.problems?.length) {
          await interaction.followUp({
            content: `Some travelers couldn't be drawn: ${r.problems.join('; ')}`,
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
        .addSubcommand((s) => s.setName('variable')
          .setDescription('Default target for materials asked for at varying amounts (Salt, combat drops)')
          .addIntegerOption((o) => o.setName('amount')
            .setDescription('How many to keep of each').setRequired(true).setMinValue(0))
          .addStringOption((o) => o.setName('traveler')
            .setDescription('Apply to one traveler only').addChoices(...travelerChoices)))
        .addSubcommand((s) => s.setName('band')
          .setDescription('Turn-ins for a tier range, e.g. 250 for T1–T4')
          .addIntegerOption((o) => o.setName('tier_min')
            .setDescription('Lowest tier in the band').setRequired(true).setMinValue(1).setMaxValue(10))
          .addIntegerOption((o) => o.setName('tier_max')
            .setDescription('Highest tier in the band').setRequired(true).setMinValue(1).setMaxValue(10))
          .addIntegerOption((o) => o.setName('turnins')
            .setDescription('Turn-ins to keep stocked in that range').setRequired(true).setMinValue(1).setMaxValue(100000))
          .addStringOption((o) => o.setName('traveler')
            .setDescription('Apply to one traveler only').addChoices(...travelerChoices)))
        .addSubcommand((s) => s.setName('bands-clear')
          .setDescription('Remove tier bands and fall back to the plain turn-in count')
          .addStringOption((o) => o.setName('traveler')
            .setDescription('Clear one traveler’s bands only').addChoices(...travelerChoices)))
        .addSubcommand((s) => s.setName('reminder')
          .setDescription('Ping a role before the weekly traveler task reroll')
          .addRoleOption((o) => o.setName('role')
            .setDescription('Role to ping').setRequired(true))
          .addIntegerOption((o) => o.setName('hours')
            .setDescription('How many hours ahead to ping (default 24)')
            .setMinValue(1).setMaxValue(168))
          .addChannelOption((o) => o.setName('channel')
            .setDescription('Where to ping — defaults to the tracker channel')
            .addChannelTypes(ChannelType.GuildText)))
        .addSubcommand((s) => s.setName('reminder-off')
          .setDescription('Stop the reroll reminder'))
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
        if (sub === 'variable') return setVariableDefault(interaction, rulebook);
        if (sub === 'band') return setBand(interaction, rulebook);
        if (sub === 'bands-clear') return clearBands(interaction);
        if (sub === 'reminder') return setReminder(interaction);
        if (sub === 'reminder-off') return reminderOff(interaction);
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

        if (r.status === 'no-travelers') {
          await interaction.editReply('No travelers tracked. Add one with `/traveler add`.');
          return;
        }
        if (r.status === 'no-channel') {
          await interaction.editReply('No channel set. Use `/setup channel` first.');
          return;
        }
        await interaction.editReply(
          `Redrew ${r.updated} message(s) — ${r.totalShort} material(s) below target.` +
          (r.problems?.length ? `\nProblems: ${r.problems.join('; ')}` : ''),
        );
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

/** Replace any band covering the same range, then keep the list sorted. */
function withBand(bands, tiers, turnIns) {
  const kept = (bands ?? []).filter(
    (b) => !(b?.tiers?.[0] === tiers[0] && b?.tiers?.[1] === tiers[1]),
  );
  return [...kept, { tiers, turnIns }].sort((a, b) => a.tiers[0] - b.tiers[0]);
}

async function setBand(interaction, rulebook) {
  const min = interaction.options.getInteger('tier_min');
  const max = interaction.options.getInteger('tier_max');
  const turnIns = interaction.options.getInteger('turnins');
  const traveler = interaction.options.getString('traveler');

  if (min > max) {
    await interaction.reply({
      content: `Tier range ${min}–${max} is backwards.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await updateGuildConfig(interaction.guildId, (c) => (traveler
    ? {
      ...c,
      overrides: {
        ...c.overrides,
        [traveler]: {
          ...c.overrides?.[traveler],
          tierBands: withBand(c.overrides?.[traveler]?.tierBands, [min, max], turnIns),
        },
      },
    }
    : { ...c, tierBands: withBand(c.tierBands, [min, max], turnIns) }));
  invalidate(interaction.guildId);

  // A band is turn-ins, not an amount, so what it costs varies by material.
  // Showing two real examples makes the scale obvious before it surprises anyone.
  const pool = Object.entries(rulebook.travelers)
    .filter(([name]) => !traveler || name === traveler)
    .flatMap(([, t]) => t.materials)
    .filter((m) => m.fixed && m.tier >= min && m.tier <= max);
  const costs = [...new Set(pool.map((m) => m.perTurnIn))].sort((a, b) => a - b);
  const example = costs.length
    ? ` For T${min}–T${max} that is ${(costs[0] * turnIns).toLocaleString()}` +
      (costs.length > 1 ? ` to ${(costs.at(-1) * turnIns).toLocaleString()}` : '') +
      ' of each material, depending on how many a task asks for.'
    : '';

  await interaction.reply({
    content: (traveler
      ? `**${traveler}**: tiers ${min}–${max} now target **${turnIns}** turn-ins.`
      : `Tiers ${min}–${max} now target **${turnIns}** turn-ins by default.`) + example,
    flags: MessageFlags.Ephemeral,
  });
}

async function clearBands(interaction) {
  const traveler = interaction.options.getString('traveler');
  await updateGuildConfig(interaction.guildId, (c) => (traveler
    ? { ...c, overrides: { ...c.overrides, [traveler]: { ...c.overrides?.[traveler], tierBands: [] } } }
    : { ...c, tierBands: [] }));
  invalidate(interaction.guildId);

  await interaction.reply({
    content: traveler
      ? `Cleared **${traveler}**'s tier bands — back to the plain turn-in count.`
      : 'Cleared the default tier bands. Per-traveler bands still apply.',
    flags: MessageFlags.Ephemeral,
  });
}

async function setReminder(interaction) {
  const role = interaction.options.getRole('role');
  const hours = interaction.options.getInteger('hours');
  const channel = interaction.options.getChannel('channel');

  // The @everyone role's id is the guild id. Mentioning it as <@&id> renders
  // but never notifies, which is exactly the silent failure to refuse.
  if (role.id === interaction.guildId) {
    await interaction.reply({
      content: 'Pick a specific role rather than @everyone — make one people can opt into.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const config = await updateGuildConfig(interaction.guildId, (c) => ({
    ...c,
    reminder: {
      ...c.reminder,
      roleId: role.id,
      hoursBefore: hours ?? sanitizeHours(c.reminder?.hoursBefore),
      channelId: channel?.id ?? c.reminder?.channelId ?? null,
    },
  }));

  const effectiveHours = config.reminder.hoursBefore;
  const channelId = config.reminder.channelId ?? config.channelId;

  const notes = [];
  if (!channelId) {
    notes.push('no channel to ping in yet — run `/setup channel`, or pass `channel:` here');
  }
  // A non-mentionable role posts fine but notifies nobody, unless the bot may
  // force mentions in that channel. Warn now rather than at 3am on reroll day.
  const target = channel ?? (channelId ? interaction.guild.channels.cache.get(channelId) : null);
  const canForce = target?.permissionsFor?.(interaction.guild.members.me)
    ?.has(PermissionFlagsBits.MentionEveryone);
  if (!role.mentionable && !canForce) {
    notes.push(`${role} isn't mentionable, so the ping won't notify anyone — ` +
      'make it mentionable, or grant me **Mention @everyone, @here and All Roles**');
  }

  const rotation = currentRotation();
  let timing = '';
  if (rotation && rotation.atMs > Date.now()) {
    const unix = Math.floor(rotation.atMs / 1000);
    const pingUnix = Math.floor((rotation.atMs - effectiveHours * 3_600_000) / 1000);
    timing = config.reminder.announcedFor === rotation.micros
      ? `\nNext reroll <t:${unix}:F> — already pinged for this one, so the new settings apply from the next.`
      : pingUnix * 1000 <= Date.now()
        ? `\nNext reroll <t:${unix}:F> — that is inside the window, so the ping lands within a minute.`
        : `\nNext reroll <t:${unix}:F> — the ping lands <t:${pingUnix}:R>.`;
  }

  await interaction.reply({
    content: `Reroll reminder set: ${role}, **${effectiveHours}h** ahead, in ` +
      `${channelId ? `<#${channelId}>` : '*no channel yet*'}.` + timing +
      (notes.length ? `\n⚠️ ${notes.join('\n⚠️ ')}` : ''),
    flags: MessageFlags.Ephemeral,
  });
}

async function reminderOff(interaction) {
  await updateGuildConfig(interaction.guildId, (c) => ({
    ...c,
    reminder: { ...c.reminder, roleId: null },
  }));
  await interaction.reply({
    content: 'Reroll reminder off. `/config reminder` turns it back on.',
    flags: MessageFlags.Ephemeral,
  });
}

async function setVariableDefault(interaction, rulebook) {
  const amount = interaction.options.getInteger('amount');
  const traveler = interaction.options.getString('traveler');

  await updateGuildConfig(interaction.guildId, (c) => (traveler
    ? { ...c, overrides: { ...c.overrides, [traveler]: { ...c.overrides?.[traveler], variableDefault: amount } } }
    : { ...c, variableDefault: amount }));
  invalidate(interaction.guildId);

  // Say how much this actually settled, since the point is avoiding the
  // per-material prompts.
  const covered = Object.entries(rulebook.travelers)
    .filter(([name]) => !traveler || name === traveler)
    .flatMap(([, t]) => t.materials.filter((m) => !m.fixed));

  await interaction.reply({
    content: (traveler
      ? `**${traveler}**'s varying-quantity materials now target **${amount}** each`
      : `Varying-quantity materials now target **${amount}** each by default`) +
      ` — ${covered.length} material(s) covered. ` +
      'Per-material values from `/config threshold` still win.',
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

  const bandText = (bands) => (bands ?? []).length
    ? bands.map((b) => `T${b.tiers[0]}–T${b.tiers[1]}: ${b.turnIns}`).join(' · ')
    : null;

  const embed = new EmbedBuilder()
    .setTitle('Settings')
    .addFields(
      { name: 'Default channel', value: c.channelId ? `<#${c.channelId}>` : '*not set — `/setup channel`*' },
      {
        name: 'Reroll reminder',
        value: c.reminder?.roleId
          ? `<@&${c.reminder.roleId}> · ${sanitizeHours(c.reminder.hoursBefore)}h ahead · ` +
            (c.reminder.channelId ? `<#${c.reminder.channelId}>` : 'tracker channel')
          : '*off — `/config reminder`*',
      },
      { name: 'Tier bands', value: bandText(c.tierBands) ?? '*none — every tier uses the turn-in count*' },
      { name: 'Turn-ins', value: String(c.turnIns ?? 5), inline: true },
      {
        name: 'Varying-qty default',
        value: Number.isFinite(c.variableDefault) ? String(c.variableDefault) : '*not set*',
        inline: true,
      },
      { name: 'Containers', value: String(countContainers(c)), inline: true },
      { name: 'Materials watched', value: String(materialCount), inline: true },
      {
        name: 'Travelers',
        value: travelers.length
          ? travelers.map(([n, s]) => `${n} (T${s.tiers?.[0] ?? 1}–${s.tiers?.[1] ?? 10})` +
            (s.channelId ? ` → <#${s.channelId}>` : '') +
            (c.overrides?.[n]?.turnIns ? ` · ${c.overrides[n].turnIns} turn-ins` : '') +
            (bandText(c.overrides?.[n]?.tierBands) ? ` · bands ${bandText(c.overrides[n].tierBands)}` : '') +
            (Number.isFinite(c.overrides?.[n]?.variableDefault) ? ` · varying ${c.overrides[n].variableDefault}` : '') +
            (s.excluded?.length ? ` · ignoring ${s.excluded.join(', ')}` : '')).join('\n')
          : '*none — `/traveler add`*',
      },
      {
        name: 'Manual thresholds',
        value: absolutes.length ? absolutes.join('\n').slice(0, 1000) : '*none set*',
      },
    );

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
