/**
 * Minimal read-only relay client: open a socket, take one snapshot, close.
 *
 * The bot does not hold relay connections open. This is used by the rulebook
 * script and by the rotation-timer check (DESIGN.md §3, §9).
 *
 * Node's built-in WebSocket connects to both relays unaided — the TLS
 * renegotiation workaround that older guides describe is obsolete (§4.1).
 */
import { parseEnvelope, rowsFromSnapshot, columnsOf } from './decode.mjs';

export const RELAYS = [
  {
    name: 'bitjita',
    http: (region) => `https://relay.bitjita.com/v1/database/bitcraft-live-${region}`,
    ws: (region) => `wss://relay.bitjita.com/v1/database/bitcraft-live-${region}`,
  },
  {
    name: 'bitcraftsync',
    http: (region) => `https://relay.bitcraftsync.app:${3000 + region}/v1/database/bitcraft-live-${region}`,
    ws: (region) => `wss://relay.bitcraftsync.app:${3000 + region}/v1/database/bitcraft-live-${region}`,
  },
];

const SUBPROTOCOL = 'v1.json.spacetimedb';

export async function fetchSchema(relay, region, { signal } = {}) {
  const res = await fetch(`${relay.http(region)}/schema?version=9`, { signal });
  if (!res.ok) throw new Error(`schema ${res.status} from ${relay.name}`);
  return res.json();
}

/**
 * Subscribe to `queries`, wait for the initial snapshot, return raw rows per table.
 * Resolves to { relay, message }.
 */
export function snapshot(relay, region, queries, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = `${relay.ws(region)}/subscribe?compression=None`;
    let ws;
    try {
      ws = new WebSocket(url, [SUBPROTOCOL]);
    } catch (err) {
      reject(new Error(`${relay.name}: ${err.message}`));
      return;
    }

    const done = (fn, arg) => {
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closing */ }
      fn(arg);
    };
    const timer = setTimeout(
      () => done(reject, new Error(`${relay.name}: snapshot timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ Subscribe: { query_strings: queries, request_id: 1 } }));
    });
    ws.addEventListener('error', () => {
      // The error event carries no useful detail in Node; the close event does.
      done(reject, new Error(`${relay.name}: websocket error`));
    });
    ws.addEventListener('close', (ev) => {
      done(reject, new Error(`${relay.name}: closed before snapshot (code ${ev.code})`));
    });
    ws.addEventListener('message', async (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : await ev.data.text();
      // IdentityToken and others arrive first; wait for the snapshot.
      if (!raw.includes('"InitialSubscription"')) return;
      done(resolve, { relay, message: parseEnvelope(raw) });
    });
  });
}

/**
 * Read whole tables, trying each relay in turn. Returns rows normalised to named
 * objects, so callers need not care which relay answered.
 *
 * Backs off on failure rather than on connect — hammering a relay with retries
 * is what degrades it for everyone.
 */
export async function readTables(tableNames, { region = 12, relays = RELAYS, onLog = () => {} } = {}) {
  const queries = tableNames.map((t) => `SELECT * FROM ${t}`);
  const failures = [];

  for (const relay of relays) {
    try {
      onLog(`trying ${relay.name} (region ${region})…`);
      const schema = await fetchSchema(relay, region);
      const { message } = await snapshot(relay, region, queries);
      const out = {};
      for (const name of tableNames) {
        out[name] = rowsFromSnapshot(message, name, columnsOf(schema, name));
      }
      onLog(`  ${relay.name} ok — ${tableNames.map((t) => `${t}:${out[t].length}`).join(' ')}`);
      return { relay: relay.name, tables: out };
    } catch (err) {
      failures.push(`${relay.name}: ${err.message}`);
      onLog(`  ${relay.name} failed — ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error(`all relays failed:\n  ${failures.join('\n  ')}`);
}
