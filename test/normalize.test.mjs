import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pocketsOf, itemTypeOf, itemKey, contentsOf, tally,
  claimContainers, playerContainers, houseContainers,
} from '../src/stock/normalize.mjs';

// Real fragments of each of the three endpoint shapes (DESIGN.md §4.13).
const CLAIM_BUILDING = {
  entityId: '864691128481122398',
  buildingName: 'Rough Barter Stall',
  buildingNickname: 'Alesi Tasks',
  inventory: [
    { locked: false, volume: 600000, contents: { item_id: 1100007, quantity: 4000, item_type: 'item' } },
    { locked: false, volume: 600000, contents: null },
  ],
};

const PLAYER_INVENTORY = {
  entityId: '648518346360148385',
  ownerEntityId: '1369094286781181638',
  inventoryName: 'Toolbelt',
  pockets: [
    { locked: false, volume: 600000, contents: { itemId: 1100007, itemType: 0, quantity: 5 } },
    { locked: false, volume: 600000, contents: { itemId: 1200, itemType: 1, quantity: 2 } },
  ],
};

const HOUSE_INVENTORY = {
  entityId: '1369094288186713242',
  buildingName: 'Skillful Leathercraft Item Storage',
  buildingNickname: 'Logs',
  inventory: [
    { locked: false, volume: 600000, contents: { item_id: 1050001, quantity: 1000, item_type: 'item' } },
  ],
};

test('pocketsOf handles both pocket array names', () => {
  assert.equal(pocketsOf(CLAIM_BUILDING).length, 2);
  assert.equal(pocketsOf(PLAYER_INVENTORY).length, 2);
  assert.equal(pocketsOf(HOUSE_INVENTORY).length, 1);
  assert.deepEqual(pocketsOf(null), []);
  assert.deepEqual(pocketsOf({}), []);
});

test('itemTypeOf accepts both the string and numeric encodings', () => {
  assert.equal(itemTypeOf('item'), 'item');
  assert.equal(itemTypeOf(0), 'item');
  assert.equal(itemTypeOf('cargo'), 'cargo');
  assert.equal(itemTypeOf(1), 'cargo');
  assert.equal(itemTypeOf(undefined), 'item');
});

test('itemKey separates item and cargo sharing a number', () => {
  assert.notEqual(itemKey('item', 1), itemKey('cargo', 1));
  assert.equal(itemKey(0, 1), itemKey('item', 1));
});

test('contentsOf normalises all three shapes to one', () => {
  assert.deepEqual(contentsOf(CLAIM_BUILDING.inventory[0]),
    { itemId: '1100007', itemType: 'item', quantity: 4000, key: 'item:1100007' });
  assert.deepEqual(contentsOf(PLAYER_INVENTORY.pockets[0]),
    { itemId: '1100007', itemType: 'item', quantity: 5, key: 'item:1100007' });
  assert.deepEqual(contentsOf(HOUSE_INVENTORY.inventory[0]),
    { itemId: '1050001', itemType: 'item', quantity: 1000, key: 'item:1050001' });
});

test('contentsOf returns null for empty pockets', () => {
  assert.equal(contentsOf({ contents: null }), null);
  assert.equal(contentsOf({}), null);
  assert.equal(contentsOf(undefined), null);
});

test('tally sums the same item across differently-shaped containers', () => {
  const totals = tally([CLAIM_BUILDING, PLAYER_INVENTORY, HOUSE_INVENTORY]);
  assert.equal(totals.get('item:1100007'), 4005);   // 4000 claim + 5 toolbelt
  assert.equal(totals.get('cargo:1200'), 2);
  assert.equal(totals.get('item:1050001'), 1000);
});

test('tally accumulates into an existing map', () => {
  const seed = new Map([['item:1100007', 10]]);
  tally([PLAYER_INVENTORY], seed);
  assert.equal(seed.get('item:1100007'), 15);
});

test('a container shape that slipped through would read as zero, not throw', () => {
  // Guards the failure mode the design warns about: a missed shape looks like a
  // genuine shortfall rather than a bug, so it must at least be detectable.
  const unknownShape = { entityId: '1', slots: [{ contents: { itemId: 5, quantity: 99 } }] };
  const totals = tally([unknownShape]);
  assert.equal(totals.size, 0);
});

test('claimContainers prefers the nickname a player set', () => {
  const [c] = claimContainers({ buildings: [CLAIM_BUILDING] });
  assert.equal(c.name, 'Alesi Tasks');
  assert.equal(c.origin, 'claim');
  assert.equal(c.pockets.length, 2);
});

test('playerContainers distinguishes personal storage from claim banks', () => {
  const payload = {
    inventories: [
      PLAYER_INVENTORY,
      { entityId: '9', ownerEntityId: '999', inventoryName: 'Town Bank', claimName: 'Aurelia', pockets: [] },
    ],
  };
  const [personal, bank] = playerContainers(payload, '1369094286781181638');
  assert.equal(personal.origin, 'personal');
  assert.equal(bank.origin, 'bank');
  assert.equal(bank.claimName, 'Aurelia');
});

test('a deployable is not filed as a claim bank', () => {
  // Real shape: a wagon is owned by the deployable, not the player, and sits in
  // no claim. Keying on owner id alone would call this a bank.
  const payload = {
    inventories: [{
      entityId: '1369094287796856539',
      ownerEntityId: '1369094287796856539',
      inventoryName: "Velcruza's Wagon (III)",
      claimName: null,
      pockets: [],
    }],
  };
  const [wagon] = playerContainers(payload, '1369094286781181638');
  assert.equal(wagon.origin, 'deployable');
  assert.notEqual(wagon.origin, 'bank');
});

test('a bank is identified by its claim, not by ownership alone', () => {
  const payload = {
    inventories: [{
      entityId: '5', ownerEntityId: '999', inventoryName: 'Ancient Bank',
      claimName: 'Amberfall', pockets: [],
    }],
  };
  assert.equal(playerContainers(payload, '1')[0].origin, 'bank');
});

test('houseContainers surfaces buildingNickname', () => {
  const [c] = houseContainers({ inventories: [HOUSE_INVENTORY] });
  assert.equal(c.name, 'Logs');
  assert.equal(c.origin, 'house');
  assert.equal(c.pockets.length, 1);
});
