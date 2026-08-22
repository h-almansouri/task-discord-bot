/**
 * When do traveler tasks reroll, and is it time to say so?
 *
 * The clock is `traveler_task_loop_timer` on a relay — a single row whose
 * `scheduled_at` holds the next reroll as microseconds since epoch
 * (DESIGN.md §9). The per-player `expirationTimestamp` on bitjita is NOT this
 * clock; it is a stale per-player snapshot (§4.9).
 *
 * Everything here is pure. The relay read and the Discord send live in
 * poll.mjs, so every decision can be tested without either.
 */

const DEFAULT_HOURS = 24;

/**
 * The microseconds out of a `scheduled_at` value, as a digits-only string.
 *
 * The payload differs by relay (verified 2026-08-22):
 *   bitjita        [1, ["1787841981396070"]]
 *   bitcraftsync   [1, {"__timestamp_micros_since_unix_epoch__": "1787841981396070"}]
 *
 * Tag 1 is an absolute time. Tag 0 would be an interval, which has no absolute
 * moment a snapshot can anchor to — null, and the reminder simply stays quiet,
 * rather than a guessed time that pings at the wrong moment.
 */
export function microsFromScheduledAt(scheduledAt) {
  if (!Array.isArray(scheduledAt) || scheduledAt[0] !== 1) return null;
  const payload = scheduledAt[1];
  const value = Array.isArray(payload)
    ? payload[0]
    : payload?.__timestamp_micros_since_unix_epoch__;
  const text = typeof value === 'number' ? String(value) : value;
  return typeof text === 'string' && /^\d+$/.test(text) ? text : null;
}

/**
 * The rotation a set of timer rows describes: { micros, atMs } or null.
 *
 * The table holds one row, replaced weekly. If several ever appear, the latest
 * timestamp is the freshest schedule. atMs divides via BigInt because the
 * micros arrive as a 16-digit string (§4.5 quoting), and stays exact — the
 * millisecond value is far below Number.MAX_SAFE_INTEGER.
 */
export function rotationFromRows(rows) {
  let best = null;
  for (const row of rows ?? []) {
    const micros = microsFromScheduledAt(row?.scheduled_at);
    if (micros && (!best || BigInt(micros) > BigInt(best))) best = micros;
  }
  return best ? { micros: best, atMs: Number(BigInt(best) / 1000n) } : null;
}

/** Hours before the reroll to ping. Anything unusable falls back to the default. */
export function sanitizeHours(hours) {
  return Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_HOURS;
}

/**
 * Ping, or not? First reason wins.
 *
 * `announcedFor` is the micros string of the rotation last pinged, persisted in
 * guild config so a restart cannot re-ping (§9). Keyed on the timestamp rather
 * than scheduled_id on purpose: if the schedule itself moves, the new time is
 * news and deserves its own ping.
 */
export function shouldAnnounce({ rotation, reminder, nowMs }) {
  if (!rotation) return { announce: false, reason: 'no-rotation' };
  if (!reminder?.roleId) return { announce: false, reason: 'no-role' };
  if (rotation.atMs <= nowMs) return { announce: false, reason: 'rotation-passed' };
  if (reminder.announcedFor === rotation.micros) return { announce: false, reason: 'already-announced' };
  const opensAtMs = rotation.atMs - sanitizeHours(reminder.hoursBefore) * 3_600_000;
  if (nowMs < opensAtMs) return { announce: false, reason: 'before-window' };
  return { announce: true, reason: 'window' };
}

/**
 * The ping itself — a new message, never a tracker edit; a silent edit is
 * exactly what nobody notices (§9). allowedMentions names the one role so
 * nothing else in the text can ever ping.
 */
export function renderReminder(rotation, reminder) {
  const unix = Math.floor(rotation.atMs / 1000);
  return {
    content: `<@&${reminder.roleId}> Traveler tasks reroll <t:${unix}:R> — <t:${unix}:F>. ` +
      'Turn in what you can and restock before then.',
    allowedMentions: { roles: [reminder.roleId] },
  };
}
