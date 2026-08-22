import 'dotenv/config';
import { Client, GatewayIntentBits, Events, MessageFlags } from 'discord.js';
import { loadRulebook } from './rulebook/load.mjs';
import { buildCommands, routeComponent, routeModal } from './commands/index.mjs';
import { startTracker, DEFAULT_INTERVAL_MS } from './tracker/poll.mjs';
import { startReminder } from './reminder/poll.mjs';

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
const ctx = { rulebook };

// No message content intent: everything runs through slash commands, so the bot
// needs no privileged intents and no message-reading permission.
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

let stopTracker = null;
let stopReminder = null;

client.once(Events.ClientReady, (c) => {
  console.log(`logged in as ${c.user.tag}`);
  console.log(`serving ${c.guilds.cache.size} guild(s): ${[...c.guilds.cache.values()].map((g) => g.name).join(', ') || '(none yet)'}`);
  stopTracker = startTracker(c, { rulebook });
  console.log(`tracker polling every ${DEFAULT_INTERVAL_MS / 1000}s`);
  stopReminder = startReminder(c);
  console.log('reminder watching the reroll timer');
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      await commands.get(interaction.commandName)?.autocomplete?.(interaction);
      return;
    }
    if (interaction.isChatInputCommand()) {
      await commands.get(interaction.commandName)?.run(interaction);
      return;
    }
    if (interaction.isModalSubmit()) {
      await routeModal(interaction, ctx);
      return;
    }
    if (interaction.isStringSelectMenu() || interaction.isButton()) {
      await routeComponent(interaction, ctx);
    }
  } catch (err) {
    const label = interaction.commandName ?? interaction.customId ?? 'interaction';
    console.error(`${label} failed:`, err);
    if (interaction.isAutocomplete?.()) return;
    const msg = { content: 'That hit an error. Check the bot logs.', flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) await interaction.followUp(msg).catch(() => {});
    else await interaction.reply?.(msg).catch(() => {});
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n${signal} — shutting down`);
    stopTracker?.();
    stopReminder?.();
    client.destroy();
    process.exit(0);
  });
}

await client.login(token);
