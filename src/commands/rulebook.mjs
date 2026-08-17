import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { findTraveler, groupByTag } from '../rulebook/load.mjs';

export function rulebookCommands(rulebook) {
  const travelerNames = Object.keys(rulebook.travelers).sort();

  return [
    {
      data: new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Check the bot is alive and see its latency'),
      async run(interaction) {
        await interaction.reply({
          content: `Pong — websocket heartbeat ${Math.round(interaction.client.ws.ping)}ms`,
          flags: MessageFlags.Ephemeral,
        });
      },
    },

    {
      data: new SlashCommandBuilder()
        .setName('travelers')
        .setDescription('List every traveler and how many materials they can ask for'),
      async run(interaction) {
        const lines = Object.entries(rulebook.travelers)
          .sort((a, b) => b[1].materials.length - a[1].materials.length)
          .map(([name, t]) => {
            const variable = t.materials.filter((m) => !m.fixed).length;
            const note = variable ? ` · ${variable} need a manual threshold` : '';
            return `**${name}** — ${t.taskCount} tasks, ${t.materials.length} materials${note}`;
          });

        const embed = new EmbedBuilder()
          .setTitle('BitCraft travelers')
          .setDescription(lines.join('\n'))
          .setFooter({
            text: `rulebook ${rulebook.counts.tasks} tasks · from ${rulebook.source} ` +
              `· ${rulebook.generatedAt?.slice(0, 10) ?? 'unknown date'}`,
          });

        await interaction.reply({ embeds: [embed] });
      },
    },

    {
      data: new SlashCommandBuilder()
        .setName('traveler')
        .setDescription('Show everything a traveler can ask for, grouped by material family')
        .addStringOption((o) => o
          .setName('name')
          .setDescription('Which traveler')
          .setRequired(true)
          .addChoices(...travelerNames.map((n) => ({ name: n, value: n })))),
      async run(interaction) {
        const wanted = interaction.options.getString('name');
        const traveler = findTraveler(rulebook, wanted);
        if (!traveler) {
          await interaction.reply({
            content: `No traveler called "${wanted}".`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const turnIns = 5; // placeholder until /config lands
        const sections = groupByTag(traveler.materials).map(([tag, mats]) => {
          const tiers = mats.map((m) => m.tier).filter((t) => t != null && t > 0);
          const range = tiers.length ? `T${Math.min(...tiers)}–T${Math.max(...tiers)}` : 'untiered';
          if (mats.every((m) => m.fixed) && new Set(mats.map((m) => m.perTurnIn)).size === 1) {
            const per = mats[0].perTurnIn;
            return `\`${tag}\` — ${per}/turn-in · ${range} · target ${per * turnIns}/tier`;
          }
          const variable = mats.filter((m) => !m.fixed);
          if (variable.length) {
            return `\`${tag}\` — ${range} · ${variable.length} need a manual threshold ` +
              `(${variable.map((m) => m.name).join(', ')})`;
          }
          return `\`${tag}\` — ${range} · ${mats.length} materials`;
        });

        const embed = new EmbedBuilder()
          .setTitle(`${traveler.name} · ${traveler.taskCount} tasks · ${traveler.materials.length} materials`)
          .setDescription(sections.join('\n'))
          .setFooter({ text: `targets shown at ${turnIns} turn-ins (placeholder until /config lands)` });

        await interaction.reply({ embeds: [embed] });
      },
    },
  ];
}
