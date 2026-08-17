/**
 * Decoding SpacetimeDB relay payloads.
 *
 * Two relays serve the same data in different shapes (DESIGN.md §4.2):
 *   relay.bitcraftsync.app -> rows are named objects
 *   relay.bitjita.com      -> rows are positional arrays in schema column order
 *
 * Both wrap rows as JSON-encoded *strings* inside the envelope, which is why the
 * big-integer fix must be applied per row and never to the whole message.
 */

/** Matches a 16+ digit integer in a JSON value position. */
const BIG_INT = /([\[,:])\s*(-?\d{16,})/g;

/**
 * Parse the outer message. Deliberately does NOT touch big integers: rows are
 * JSON strings inside this structure, and substituting here would inject quotes
 * inside a string literal and corrupt the envelope.
 */
export function parseEnvelope(raw) {
  return JSON.parse(raw);
}

/**
 * Parse a single row string, quoting u64s first so they survive as strings.
 * `JSON.parse` would otherwise round 1369094286781181638 to ...1700.
 */
export function parseRow(rowText) {
  const text = typeof rowText === 'string' ? rowText : JSON.stringify(rowText);
  return JSON.parse(text.replace(BIG_INT, '$1"$2"'));
}

/**
 * Column names for a table, in positional order, from a `?version=9` schema.
 */
export function columnsOf(schema, tableName) {
  const table = (schema.tables ?? []).find((t) => t.name === tableName);
  if (!table) throw new Error(`table not in schema: ${tableName}`);
  const elements = schema.typespace?.types?.[table.product_type_ref]?.Product?.elements;
  if (!elements) throw new Error(`no column layout for table: ${tableName}`);
  // Column names arrive as either {some: "id"} or a bare string depending on version.
  return elements.map((el) => el.name?.some ?? el.name);
}

/**
 * Positional array -> named object. Rows that already arrived named pass through
 * untouched, so callers can treat either relay identically.
 */
export function toNamed(row, columns) {
  if (!Array.isArray(row)) return row;
  const out = {};
  for (let i = 0; i < columns.length; i++) out[columns[i]] = row[i];
  return out;
}

/**
 * Pull the rows of one table out of an InitialSubscription message.
 * `columns` is optional; supply it to normalise positional rows to named ones.
 */
export function rowsFromSnapshot(message, tableName, columns) {
  const tables = message?.InitialSubscription?.database_update?.tables ?? [];
  const table = tables.find((t) => t.table_name === tableName);
  if (!table) return [];
  const rows = (table.updates ?? []).flatMap((u) => (u.inserts ?? []).map(parseRow));
  return columns ? rows.map((r) => toNamed(r, columns)) : rows;
}

/**
 * `level_requirement` is `{skill_id,…}` when named and `[skill_id,…]` when
 * positional. Everything nested deeper (required_items) is positional on both.
 */
export function skillIdOf(task) {
  const lr = task.level_requirement;
  if (lr == null) return undefined;
  return Array.isArray(lr) ? lr[0] : lr.skill_id;
}

/** `[item_id, quantity, [typeTag, …], …]` -> a flat, named requirement. */
export function requirementsOf(task) {
  return (task.required_items ?? []).map((ri) => {
    const [itemId, quantity, typeField] = ri;
    const tag = Array.isArray(typeField) ? typeField[0] : typeField;
    return {
      itemId: String(itemId),
      quantity,
      itemType: tag === 1 ? 'cargo' : 'item',
    };
  });
}
