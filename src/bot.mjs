import 'dotenv/config';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import { loadRulebook } from './rulebook/load.mjs';
import { buildCommands } from './commands.mjs';

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
  if (!interaction.isChatInputCommand()) return;
  const command = commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.run(interaction);
  } catch (err) {
    console.error(`/${interaction.commandName} failed:`, err);
    const msg = { content: 'That command hit an error. Check the bot logs.', ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.followUp(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
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
