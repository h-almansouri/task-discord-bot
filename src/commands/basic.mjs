import { SlashCommandBuilder, MessageFlags } from 'discord.js';

/** Commands that belong to the bot itself rather than to any tracked data. */
export function basicCommands() {
  return [{
    data: new SlashCommandBuilder()
      .setName('ping')
      .setDescription('Check the bot is alive and see its latency'),
    async run(interaction) {
      await interaction.reply({
        content: `Pong — websocket heartbeat ${Math.round(interaction.client.ws.ping)}ms`,
        flags: MessageFlags.Ephemeral,
      });
    },
  }];
}
