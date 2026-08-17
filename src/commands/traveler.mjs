/**
 * /traveler — which travelers to track, at which tiers.
 *
 * Adding a traveler with variable-quantity materials prompts for their numbers
 * inline. Skipping a prompt leaves that material untracked and visible in
 * /traveler list; it is never silently defaulted to a guess (DESIGN.md §5).
 */
import {
  SlashCommandBuilder, EmbedBuilder, MessageFlags,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { findTraveler, groupByTag } from '../rulebook/load.mjs';
import { loadGuildConfig, updateGuildConfig } from '../config/store.mjs';
import { unconfiguredMaterials, resolveTarget, inTierRange } from '../tracker/thresholds.mjs';
import { invalidate } from '../tracker/poll.mjs';

export const PREFIX = 'tv';
const cid = (...parts) => [PREFIX, ...parts].join('|');

export function travelerCommands(rulebook) {
  const names = Object.keys(rulebook.travelers).sort();
  const choices = names.map((n) => ({ name: n, value: n }));

  return [{
    data: new SlashCommandBuilder()
      .setName('traveler')
      .setDescription('Choose which travelers to keep stocked')
      // add/remove use autocomplete rather than fixed choices: the useful list
      // differs per guild — untracked travelers for add, tracked ones for
      // remove — and registered choices are the same for everyone.
      .addSubcommand((s) => s.setName('add')
        .setDescription('Track a traveler')
        .addStringOption((o) => o.setName('name').setDescription('Which traveler')
          .setRequired(true).setAutocomplete(true))
        .addIntegerOption((o) => o.setName('tier_min').setDescription('Lowest tier to watch (default 1)')
          .setMinValue(1).setMaxValue(10))
        .addIntegerOption((o) => o.setName('tier_max').setDescription('Highest tier to watch (default 10)')
          .setMinValue(1).setMaxValue(10)))
      .addSubcommand((s) => s.setName('remove')
        .setDescription('Stop tracking a traveler')
        .addStringOption((o) => o.setName('name').setDescription('Which traveler')
          .setRequired(true).setAutocomplete(true)))
      .addSubcommand((s) => s.setName('list')
        .setDescription('Show which travelers are tracked'))
      .addSubcommand((s) => s.setName('info')
        .setDescription('Show everything a traveler can ask for')
        .addStringOption((o) => o.setName('name').setDescription('Which traveler')
          .setRequired(true).addChoices(...choices))),

    async autocomplete(interaction) {
      const sub = interaction.options.getSubcommand();
      const typed = interaction.options.getFocused().toLowerCase();
      const config = await loadGuildConfig(interaction.guildId);
      const tracked = new Set(Object.keys(config.travelers ?? {}));

      let pool = Object.keys(rulebook.travelers).sort();
      if (sub === 'add') pool = pool.filter((n) => !tracked.has(n));
      if (sub === 'remove') pool = pool.filter((n) => tracked.has(n));

      await interaction.respond(
        pool.filter((n) => n.toLowerCase().includes(typed))
          .slice(0, 25)
          .map((n) => ({ name: n, value: n })),
      );
    },

    async run(interaction) {
      if (!interaction.inGuild()) {
        await interaction.reply({ content: 'Use this in a server, not a DM.', flags: MessageFlags.Ephemeral });
        return;
      }
      const sub = interaction.options.getSubcommand();
      if (sub === 'add') return runAdd(interaction, rulebook);
      if (sub === 'remove') return runRemove(interaction, rulebook);
      if (sub === 'list') return runList(interaction, rulebook);
      if (sub === 'info') return runInfo(interaction, rulebook);
    },
  }];
}

async function runAdd(interaction, rulebook) {
  const name = interaction.options.getString('name');
  const traveler = findTraveler(rulebook, name);
  if (!traveler) {
    await interaction.reply({ content: `No traveler called "${name}".`, flags: MessageFlags.Ephemeral });
    return;
  }

  const min = interaction.options.getInteger('tier_min') ?? 1;
  const max = interaction.options.getInteger('tier_max') ?? 10;
  if (min > max) {
    await interaction.reply({
      content: `Tier range ${min}–${max} is backwards.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const before = await loadGuildConfig(interaction.guildId);
  const wasTracked = Boolean(before.travelers?.[traveler.name]);

  const config = await updateGuildConfig(interaction.guildId, (c) => ({
    ...c,
    travelers: { ...c.travelers, [traveler.name]: { tiers: [min, max] } },
  }));
  invalidate(interaction.guildId);

  const inRange = traveler.materials.filter((m) => inTierRange(m, [min, max]));
  const pending = unconfiguredMaterials(config, traveler.name, traveler);
  // Tracked travelers are filtered out of the autocomplete, so reaching here
  // means the name was typed deliberately — treat it as a tier-range change.
  const verb = wasTracked ? 'Updated' : 'Tracking';

  if (!pending.length) {
    await interaction.reply({
      content: `${verb} **${traveler.name}** at tiers ${min}–${max} — ${inRange.length} materials, all ready.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    ...thresholdStep(traveler.name, pending, config),
    flags: MessageFlags.Ephemeral,
  });
}

/** Prompt for the materials that still need an absolute number. */
function thresholdStep(travelerName, pending, config) {
  const embed = new EmbedBuilder()
    .setTitle(`${travelerName} — ${pending.length} material(s) need a number`)
    .setDescription(
      'These are asked for at several different quantities, so "turn-ins" has no ' +
      'single meaning. Set a plain stock target for each.\n\n' +
      pending.map((m) => {
        const set = config.absolute?.[m.key];
        return `• **${m.name}** — asked for at ${m.quantities.join(', ')}` +
          (Number.isFinite(set) ? ` · target **${set}**` : ' · *not set*');
      }).join('\n'),
    )
    .setFooter({ text: 'Anything left unset stays untracked — nothing is guessed.' });

  const menu = new StringSelectMenuBuilder()
    .setCustomId(cid('pickmat', travelerName))
    .setPlaceholder('Choose a material to set…')
    .addOptions(pending.slice(0, 25).map((m) => new StringSelectMenuOptionBuilder()
      .setLabel(m.name.slice(0, 100))
      .setValue(m.key)
      .setDescription(`asked for at ${m.quantities.join(', ')}`.slice(0, 100))));

  const done = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(cid('done', travelerName))
      .setLabel('Done').setStyle(ButtonStyle.Success),
  );

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu), done] };
}

async function runRemove(interaction, rulebook) {
  const name = interaction.options.getString('name');
  const config = await loadGuildConfig(interaction.guildId);
  if (!config.travelers?.[name]) {
    await interaction.reply({ content: `**${name}** is not tracked.`, flags: MessageFlags.Ephemeral });
    return;
  }
  await updateGuildConfig(interaction.guildId, (c) => {
    const travelers = { ...c.travelers };
    delete travelers[name];
    return { ...c, travelers };
  });
  invalidate(interaction.guildId);
  await interaction.reply({ content: `Stopped tracking **${name}**.`, flags: MessageFlags.Ephemeral });
}

async function runList(interaction, rulebook) {
  const config = await loadGuildConfig(interaction.guildId);
  const entries = Object.entries(config.travelers ?? {});
  if (!entries.length) {
    await interaction.reply({
      content: 'No travelers tracked. Add one with `/traveler add`.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const lines = entries.map(([name, settings]) => {
    const traveler = rulebook.travelers[name];
    if (!traveler) return `**${name}** — not in the rulebook (regenerate it?)`;
    const inRange = traveler.materials.filter((m) => inTierRange(m, settings.tiers));
    const pending = unconfiguredMaterials(config, name, traveler);
    const turnIns = config.overrides?.[name]?.turnIns ?? config.turnIns;
    return `**${name}** — tiers ${settings.tiers?.[0] ?? 1}–${settings.tiers?.[1] ?? 10} · ` +
      `${inRange.length} materials · ${turnIns} turn-ins` +
      (pending.length ? `\n   ⚠️ ${pending.length} awaiting a threshold: ${pending.map((m) => m.name).join(', ')}` : '');
  });

  await interaction.reply({
    embeds: [new EmbedBuilder().setTitle('Tracked travelers').setDescription(lines.join('\n'))],
    flags: MessageFlags.Ephemeral,
  });
}

async function runInfo(interaction, rulebook) {
  const traveler = findTraveler(rulebook, interaction.options.getString('name'));
  const config = await loadGuildConfig(interaction.guildId);
  const turnIns = config.overrides?.[traveler.name]?.turnIns ?? config.turnIns ?? 5;

  const sections = groupByTag(traveler.materials).map(([tag, mats]) => {
    const tiers = mats.map((m) => m.tier).filter((t) => t != null && t > 0);
    const range = tiers.length ? `T${Math.min(...tiers)}–T${Math.max(...tiers)}` : 'untiered';
    const variable = mats.filter((m) => !m.fixed);
    if (variable.length) {
      return `\`${tag}\` — ${range} · ${variable.length} need a manual threshold ` +
        `(${variable.map((m) => m.name).join(', ')})`;
    }
    const per = mats[0].perTurnIn;
    return new Set(mats.map((m) => m.perTurnIn)).size === 1
      ? `\`${tag}\` — ${per}/turn-in · ${range} · target ${per * turnIns}/tier`
      : `\`${tag}\` — ${range} · ${mats.length} materials`;
  });

  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setTitle(`${traveler.name} · ${traveler.taskCount} tasks · ${traveler.materials.length} materials`)
      .setDescription(sections.join('\n'))
      .setFooter({ text: `targets shown at ${turnIns} turn-ins` })],
  });
}

// --- components ------------------------------------------------------------

export async function handleComponent(interaction, { rulebook }) {
  const [, action, travelerName] = interaction.customId.split('|');

  if (action === 'pickmat') {
    const key = interaction.values[0];
    const traveler = rulebook.travelers[travelerName];
    const material = traveler?.materials.find((m) => m.key === key);
    const config = await loadGuildConfig(interaction.guildId);
    const current = config.absolute?.[key];

    const modal = new ModalBuilder()
      .setCustomId(cid('setmat', travelerName, key))
      .setTitle(`Target for ${material?.name ?? 'material'}`.slice(0, 45))
      .addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('amount')
          .setLabel('How many to keep in stock')
          .setPlaceholder(material ? `asked for at ${material.quantities.join(', ')}` : 'a whole number')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(Number.isFinite(current) ? String(current) : ''),
      ));
    await interaction.showModal(modal);
    return;
  }

  if (action === 'done') {
    await interaction.update({
      content: `Done. \`/traveler list\` shows anything still awaiting a threshold.`,
      embeds: [], components: [],
    });
    return;
  }

  await interaction.deferUpdate().catch(() => {});
}

export async function handleModal(interaction, { rulebook }) {
  const [, action, travelerName, key] = interaction.customId.split('|');
  if (action !== 'setmat') return;

  const raw = interaction.fields.getTextInputValue('amount').trim().replace(/[, ]/g, '');
  const amount = Number(raw);
  if (!Number.isInteger(amount) || amount < 0) {
    await interaction.reply({
      content: `"${raw}" is not a whole number. Try again from \`/traveler list\`.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const config = await updateGuildConfig(interaction.guildId, (c) => ({
    ...c,
    absolute: { ...c.absolute, [key]: amount },
  }));
  invalidate(interaction.guildId);

  const traveler = rulebook.travelers[travelerName];
  const material = traveler?.materials.find((m) => m.key === key);
  const pending = traveler
    ? unconfiguredMaterials(config, travelerName, { ...traveler, name: travelerName })
    : [];

  if (!pending.length) {
    await interaction.update({
      content: `**${material?.name ?? key}** set to **${amount}**. All of ${travelerName}'s materials are configured.`,
      embeds: [], components: [],
    });
    return;
  }
  await interaction.update({
    content: `**${material?.name ?? key}** set to **${amount}**.`,
    ...thresholdStep(travelerName, pending, config),
  });
}
