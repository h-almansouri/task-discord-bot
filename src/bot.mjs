import 'dotenv/config';
import { Client, GatewayIntentBits, Events, MessageFlags } from 'discord.js';
import { loadRulebook } from './rulebook/load.mjs';
import { buildCommands, routeComponent } from './commands/index.mjs';

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('DISCORD_TOKEN is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const rulebook = await loadRulebook();
console.log(
  `rulebook loaded: ${rulebook.counts.tasks} tasks, ` +
  `${rulebook.counts.travelers} travelers (from ${rulebook.source}, ${rulebook.generatedAt})`,
);

const commands = new Map(buildCommands(rulebook).map((c) => [c.data.name, c]));

// No message content intent: everything runs through slash commands, so the bot
// needs no privileged intents and no message-reading permission.
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (c) => {
  console.log(`logged in as ${c.user.tag}`);
  console.log(`serving ${c.guilds.cache.size} guild(s): ${[...c.guilds.cache.values()].map((g) => g.name).join(', ') || '(none yet)'}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const command = commands.get(interaction.commandName);
      if (command) await command.run(interaction);
      return;
    }
    if (interaction.isStringSelectMenu() || interaction.isButton()) {
      await routeComponent(interaction);
    }
  } catch (err) {
    const label = interaction.commandName ?? interaction.customId ?? 'interaction';
    console.error(`${label} failed:`, err);
    const msg = { content: 'That hit an error. Check the bot logs.', flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) await interaction.followUp(msg).catch(() => {});
    else await interaction.reply?.(msg).catch(() => {});
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n${signal} — shutting down`);
    client.destroy();
    process.exit(0);
  });
}

await client.login(token);
