#!/usr/bin/env node
/**
 * Register slash commands with Discord.
 *
 * With DISCORD_GUILD_ID set, commands appear in that server immediately — use
 * this while developing. Without it they register globally, which Discord can
 * take up to an hour to roll out.
 *
 *   npm run commands
 */
import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { loadRulebook } from '../src/rulebook/load.mjs';
import { buildCommands } from '../src/commands.mjs';

const { DISCORD_TOKEN: token, DISCORD_CLIENT_ID: clientId, DISCORD_GUILD_ID: guildId } = process.env;

const missing = [
  !token && 'DISCORD_TOKEN',
  !clientId && 'DISCORD_CLIENT_ID',
].filter(Boolean);
if (missing.length) {
  console.error(`Missing in .env: ${missing.join(', ')}`);
  console.error('Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const rulebook = await loadRulebook();
const body = buildCommands(rulebook).map((c) => c.data.toJSON());
const rest = new REST({ version: '10' }).setToken(token);

const route = guildId
  ? Routes.applicationGuildCommands(clientId, guildId)
  : Routes.applicationCommands(clientId);

try {
  const result = await rest.put(route, { body });
  console.log(`registered ${result.length} command(s) ${guildId ? `to guild ${guildId}` : 'globally'}:`);
  for (const c of result) console.log(`  /${c.name} — ${c.description}`);
  if (!guildId) console.log('\nGlobal commands can take up to an hour to appear. Set DISCORD_GUILD_ID for instant updates while testing.');
} catch (err) {
  console.error('Registration failed:', err.message);
  if (err.code === 50001) console.error('Missing Access — is the bot invited to that guild with the applications.commands scope?');
  if (err.status === 401) console.error('Unauthorized — DISCORD_TOKEN looks wrong. Regenerate it in the Developer Portal.');
  process.exit(1);
}
