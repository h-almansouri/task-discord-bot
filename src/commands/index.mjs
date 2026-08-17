import { rulebookCommands } from './rulebook.mjs';
import { storageCommands, handleComponent as handleStorage, PREFIX as STORAGE_PREFIX } from './storage.mjs';

export function buildCommands(rulebook) {
  return [...rulebookCommands(rulebook), ...storageCommands()];
}

/** Message-component interactions, routed by the prefix in their custom id. */
const routes = new Map([[STORAGE_PREFIX, handleStorage]]);

export async function routeComponent(interaction) {
  const prefix = interaction.customId.split('|')[0];
  const handler = routes.get(prefix);
  if (!handler) return false;
  await handler(interaction);
  return true;
}
