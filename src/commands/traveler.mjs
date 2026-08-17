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
import { findTraveler } from '../rulebook/load.mjs';
import { loadGuildConfig, updateGuildConfig, setTravelerTiers } from '../config/store.mjs';
import {
  unconfiguredMaterials, watchedMaterials, familiesOf, inTierRange,
} from '../tracker/thresholds.mjs';
import { invalidate, removeTravelerMessage } from '../tracker/poll.mjs';

export const PREFIX = 'tv';
const cid = (...parts) => [PREFIX, ...parts].join('|');

export function travelerCommands(rulebook) {
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
      .addSubcommand((s) => s.setName('update')
        .setDescription('Change a tracked traveler’s tier range, keeping everything else')
        .addStringOption((o) => o.setName('name').setDescription('Which traveler')
          .setRequired(true).setAutocomplete(true))
        .addIntegerOption((o) => o.setName('tier_min').setDescription('Lowest tier to watch')
          .setMinValue(1).setMaxValue(10))
        .addIntegerOption((o) => o.setName('tier_max').setDescription('Highest tier to watch')
          .setMinValue(1).setMaxValue(10)))
      .addSubcommand((s) => s.setName('remove')
        .setDescription('Stop tracking a traveler')
        .addStringOption((o) => o.setName('name').setDescription('Which traveler')
          .setRequired(true).setAutocomplete(true)))
      .addSubcommand((s) => s.setName('list')
        .setDescription('Show which travelers are tracked'))
      .addSubcommand((s) => s.setName('ignore')
        .setDescription('Stop watching one material family for a traveler')
        .addStringOption((o) => o.setName('traveler').setDescription('Which traveler')
          .setRequired(true).setAutocomplete(true))
        .addStringOption((o) => o.setName('family').setDescription('Which material family')
          .setRequired(true).setAutocomplete(true)))
      .addSubcommand((s) => s.setName('unignore')
        .setDescription('Watch a material family again')
        .addStringOption((o) => o.setName('traveler').setDescription('Which traveler')
          .setRequired(true).setAutocomplete(true))
        .addStringOption((o) => o.setName('family').setDescription('Which material family')
          .setRequired(true).setAutocomplete(true))),

    async autocomplete(interaction) {
      const sub = interaction.options.getSubcommand();
      const focused = interaction.options.getFocused(true);
      const typed = String(focused.value ?? '').toLowerCase();
      const config = await loadGuildConfig(interaction.guildId);
      const tracked = Object.keys(config.travelers ?? {});

      const respond = (values) => interaction.respond(
        values.filter((v) => v.name.toLowerCase().includes(typed))
          .slice(0, 25),
      );

      if (focused.name === 'family') {
        // Families of whichever traveler was picked in the other option.
        const who = interaction.options.getString('traveler');
        const traveler = who ? rulebook.travelers[who] : null;
        if (!traveler) {
          await interaction.respond([]);
          return;
        }
        const excluded = new Set(
          (config.travelers?.[who]?.excluded ?? []).map((e) => String(e).toLowerCase()),
        );
        const families = familiesOf(traveler)
          .filter(({ name }) => (sub === 'ignore'
            ? !excluded.has(name.toLowerCase())
            : excluded.has(name.toLowerCase())));
        await respond(families.map(({ name, count }) => ({
          name: `${name} (${count} tiers)`.slice(0, 100),
          value: name,
        })));
        return;
      }

      // Traveler pickers: the useful list depends on the subcommand.
      let pool = Object.keys(rulebook.travelers).sort();
      if (sub === 'add') pool = pool.filter((n) => !tracked.includes(n));
      if (['update', 'remove', 'ignore', 'unignore'].includes(sub)) {
        pool = pool.filter((n) => tracked.includes(n));
      }
      await respond(pool.map((n) => ({ name: n, value: n })));
    },

    async run(interaction) {
      if (!interaction.inGuild()) {
        await interaction.reply({ content: 'Use this in a server, not a DM.', flags: MessageFlags.Ephemeral });
        return;
      }
      const sub = interaction.options.getSubcommand();
      if (sub === 'add') return setTiers(interaction, rulebook, { updating: false });
      if (sub === 'update') return setTiers(interaction, rulebook, { updating: true });
      if (sub === 'remove') return runRemove(interaction, rulebook);
      if (sub === 'list') return runList(interaction, rulebook);
      if (sub === 'ignore' || sub === 'unignore') return runIgnore(interaction, rulebook, sub === 'ignore');
    },
  }];
}

/**
 * Shared by add and update.
 *
 * `updating` only changes the wording and which precondition is checked — the
 * write is identical, and critically it *merges* into the existing entry rather
 * than replacing it. Replacing silently discarded the traveler's channel, its
 * message id and any ignored families.
 */
async function setTiers(interaction, rulebook, { updating }) {
  const name = interaction.options.getString('name');
  const traveler = findTraveler(rulebook, name);
  if (!traveler) {
    await interaction.reply({ content: `No traveler called "${name}".`, flags: MessageFlags.Ephemeral });
    return;
  }

  const before = await loadGuildConfig(interaction.guildId);
  const existing = before.travelers?.[traveler.name];

  if (updating && !existing) {
    await interaction.reply({
      content: `**${traveler.name}** is not tracked yet — use \`/traveler add\`.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!updating && existing) {
    await interaction.reply({
      content: `**${traveler.name}** is already tracked. Use \`/traveler update\` to change its tiers, ` +
        'which keeps its channel and ignored families.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const min = interaction.options.getInteger('tier_min') ?? existing?.tiers?.[0] ?? 1;
  const max = interaction.options.getInteger('tier_max') ?? existing?.tiers?.[1] ?? 10;
  if (min > max) {
    await interaction.reply({
      content: `Tier range ${min}–${max} is backwards.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const config = await updateGuildConfig(
    interaction.guildId,
    (c) => setTravelerTiers(c, traveler.name, [min, max]),
  );
  invalidate(interaction.guildId, traveler.name);

  const inRange = traveler.materials.filter((m) => inTierRange(m, [min, max]));
  const pending = unconfiguredMaterials(config, traveler.name, traveler);
  const kept = [
    existing?.channelId && `channel <#${existing.channelId}>`,
    existing?.excluded?.length && `${existing.excluded.length} ignored family(s)`,
  ].filter(Boolean);
  const verb = updating
    ? `Updated${kept.length ? ` (kept ${kept.join(' and ')})` : ''}`
    : 'Tracking';

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
    .setFooter({
      text: 'Anything left unset stays untracked — nothing is guessed. ' +
        'To cover them all at once, use /config variable.',
    });

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
  // Tidy up the message first — once the config entry is gone, so is its id.
  const removed = await removeTravelerMessage(interaction.client, interaction.guildId, name);

  await updateGuildConfig(interaction.guildId, (c) => {
    const travelers = { ...c.travelers };
    delete travelers[name];
    return { ...c, travelers };
  });
  invalidate(interaction.guildId);

  await interaction.reply({
    content: `Stopped tracking **${name}**.` +
      (removed ? ' Its message has been deleted.' : ''),
    flags: MessageFlags.Ephemeral,
  });
}

async function runIgnore(interaction, rulebook, ignoring) {
  const who = interaction.options.getString('traveler');
  const family = interaction.options.getString('family');
  const traveler = findTraveler(rulebook, who);

  if (!traveler) {
    await interaction.reply({ content: `No traveler called "${who}".`, flags: MessageFlags.Ephemeral });
    return;
  }

  const config = await loadGuildConfig(interaction.guildId);
  if (!config.travelers?.[traveler.name]) {
    await interaction.reply({
      content: `**${traveler.name}** is not tracked. Add them with \`/traveler add\` first.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Match case-insensitively against what the rulebook actually has, so a typed
  // name that differs only in case still works.
  const known = familiesOf(traveler).find(
    (f) => f.name.toLowerCase() === String(family).toLowerCase(),
  );
  if (!known) {
    await interaction.reply({
      content: `**${traveler.name}** has no material family called "${family}". ` +
        'Pick from the suggestions.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const current = config.travelers[traveler.name].excluded ?? [];
  const already = current.some((e) => String(e).toLowerCase() === known.name.toLowerCase());
  if (ignoring === already) {
    await interaction.reply({
      content: already
        ? `**${known.name}** is already ignored for ${traveler.name}.`
        : `**${known.name}** is already being watched for ${traveler.name}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const excluded = ignoring
    ? [...current, known.name]
    : current.filter((e) => String(e).toLowerCase() !== known.name.toLowerCase());

  await updateGuildConfig(interaction.guildId, (c) => ({
    ...c,
    travelers: {
      ...c.travelers,
      [traveler.name]: { ...c.travelers[traveler.name], excluded },
    },
  }));
  invalidate(interaction.guildId);

  await interaction.reply({
    content: ignoring
      ? `Ignoring **${known.name}** for ${traveler.name} — all ${known.count} tier(s) dropped from the tracker.`
      : `Watching **${known.name}** for ${traveler.name} again.`,
    flags: MessageFlags.Ephemeral,
  });
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
    const watched = watchedMaterials(config, name, traveler);
    const pending = unconfiguredMaterials(config, name, traveler);
    const turnIns = config.overrides?.[name]?.turnIns ?? config.turnIns;
    const ignored = settings.excluded ?? [];
    return `**${name}** — tiers ${settings.tiers?.[0] ?? 1}–${settings.tiers?.[1] ?? 10} · ` +
      `${watched.length} materials · ${turnIns} turn-ins` +
      (ignored.length ? `\n   🚫 ignoring: ${ignored.join(', ')}` : '') +
      (pending.length ? `\n   ⚠️ ${pending.length} awaiting a threshold: ${pending.map((m) => m.name).join(', ')}` : '');
  });

  await interaction.reply({
    embeds: [new EmbedBuilder().setTitle('Tracked travelers').setDescription(lines.join('\n'))],
    flags: MessageFlags.Ephemeral,
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
