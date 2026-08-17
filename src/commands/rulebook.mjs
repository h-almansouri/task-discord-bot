import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';

/** Overview commands. Per-traveler detail lives in /traveler info. */
export function rulebookCommands(rulebook) {
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
  ];
}
