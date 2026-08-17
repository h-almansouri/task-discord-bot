import { rulebookCommands } from './rulebook.mjs';
import { storageCommands, handleComponent as storageComponent, PREFIX as STORAGE_PREFIX } from './storage.mjs';
import {
  travelerCommands, handleComponent as travelerComponent,
  handleModal as travelerModal, PREFIX as TRAVELER_PREFIX,
} from './traveler.mjs';
import { configCommands } from './config.mjs';

export function buildCommands(rulebook) {
  return [
    ...rulebookCommands(rulebook),
    ...storageCommands(),
    ...travelerCommands(rulebook),
    ...configCommands(rulebook),
  ];
}

/** Message components and modals, routed by the prefix in their custom id. */
const componentRoutes = new Map([
  [STORAGE_PREFIX, storageComponent],
  [TRAVELER_PREFIX, travelerComponent],
]);

const modalRoutes = new Map([
  [TRAVELER_PREFIX, travelerModal],
]);

export async function routeComponent(interaction, ctx) {
  const handler = componentRoutes.get(interaction.customId.split('|')[0]);
  if (!handler) return false;
  await handler(interaction, ctx);
  return true;
}

export async function routeModal(interaction, ctx) {
  const handler = modalRoutes.get(interaction.customId.split('|')[0]);
  if (!handler) return false;
  await handler(interaction, ctx);
  return true;
}
