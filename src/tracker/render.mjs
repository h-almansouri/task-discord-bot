/**
 * Rendering one traveler's supply table.
 *
 * Returns plain embed objects rather than builders, so this can be tested
 * without a gateway. discord.js accepts either.
 *
 * The table is an ANSI code block: Discord renders colour inside ```ansi
 * fences, and monospace is what makes a family × tier grid line up. This is
 * tuned for desktop — a ten-tier grid will wrap on a phone, which is an
 * accepted trade (DESIGN.md §8).
 */
const COLOUR_SHORT = 0xd9534f;
const COLOUR_OK = 0x5cb85c;

/** Discord's ANSI subset. Anything outside this renders as plain text. */
const ANSI = {
  reset: '[0m',
  head: '[1;37m',
  short: '[0;31m',
  ok: '[0;32m',
  none: '[0;30m',
};

const NAME_WIDTH = 16;
const CELL_WIDTH = 6;
/** Embed descriptions cap at 4096; leave room for the fence and any warning. */
const DESCRIPTION_BUDGET = 3800;

/** Discord counts title, description, footer, author and field text together. */
export function embedLength(embed) {
  return (embed.title?.length ?? 0)
    + (embed.description?.length ?? 0)
    + (embed.footer?.text?.length ?? 0)
    + (embed.author?.name?.length ?? 0)
    + (embed.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);
}

/**
 * A signed count that fits a narrow column. Targets reach five and six figures
 * once tier bands are in use, so large values are abbreviated rather than
 * allowed to break the grid.
 */
export function formatDiff(diff) {
  const sign = diff < 0 ? '-' : '+';
  const n = Math.abs(diff);
  if (n === 0) return '0';
  if (n < 1000) return sign + n;
  if (n < 10000) return `${sign}${(n / 1000).toFixed(1)}k`;
  return `${sign}${Math.round(n / 1000)}k`;
}

/**
 * One family × tier grid. Surplus is green, shortfall red, and a tier the
 * family does not have is a grey dash — Rumbagh's Ink stops at T8.
 */
export function renderTable(groups, tiers) {
  const lines = [];
  lines.push(
    ANSI.head + 'MATERIAL'.padEnd(NAME_WIDTH)
    + tiers.map((t) => `T${t}`.padStart(CELL_WIDTH)).join('')
    + ANSI.reset,
  );

  for (const group of groups) {
    const byTier = new Map(group.rows.map((r) => [r.tier, r]));
    let line = String(group.label).slice(0, NAME_WIDTH - 1).padEnd(NAME_WIDTH);
    for (const tier of tiers) {
      const row = byTier.get(tier);
      if (!row) {
        line += ANSI.none + '-'.padStart(CELL_WIDTH) + ANSI.reset;
        continue;
      }
      const colour = row.diff < 0 ? ANSI.short : ANSI.ok;
      line += colour + formatDiff(row.diff).padStart(CELL_WIDTH) + ANSI.reset;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/** Untiered materials — combat drops — as a plain list, since a grid has no axis. */
export function renderUntiered(rows) {
  return rows
    .slice()
    .sort((a, b) => a.diff - b.diff)
    .map((r) => {
      const colour = r.diff < 0 ? ANSI.short : ANSI.ok;
      return String(r.name).slice(0, 24).padEnd(25)
        + colour + formatDiff(r.diff).padStart(7) + ANSI.reset;
    })
    .join('\n');
}

/** The message for one traveler. */
export function renderTraveler(traveler, { updatedAt = null, storageCount = 0 } = {}) {
  const timestamp = new Date(updatedAt ?? Date.now()).toISOString();

  const tieredGroups = traveler.groups
    .map((g) => ({ ...g, rows: g.rows.filter((r) => r.tier >= 1) }))
    .filter((g) => g.rows.length);
  const untiered = traveler.rows.filter((r) => !(r.tier >= 1));
  const tiers = [...new Set(tieredGroups.flatMap((g) => g.rows.map((r) => r.tier)))]
    .sort((a, b) => a - b);

  const blocks = [];
  if (tieredGroups.length) blocks.push(renderTable(tieredGroups, tiers));
  if (untiered.length) blocks.push(renderUntiered(untiered));

  let body = blocks.length ? `\`\`\`ansi\n${blocks.join('\n\n')}\n\`\`\`` : '';
  if (body.length > DESCRIPTION_BUDGET) {
    body = `${body.slice(0, DESCRIPTION_BUDGET)}\n… truncated\n\`\`\``;
  }

  const notes = [];
  if (traveler.unconfigured.length) {
    const names = traveler.unconfigured.map((m) => m.name).join(', ');
    notes.push(
      `⚠️ Needs a threshold: ${names.length > 200 ? `${names.slice(0, 197)}…` : names} ` +
      '· set with `/config variable` or `/config threshold`',
    );
  }

  const range = traveler.tiers ? ` · T${traveler.tiers[0]}–${traveler.tiers[1]}` : '';
  return {
    embeds: [{
      title: `${traveler.name}${range}`,
      description: [body, ...notes].filter(Boolean).join('\n'),
      color: traveler.shortCount ? COLOUR_SHORT : COLOUR_OK,
      footer: {
        text: traveler.shortCount
          ? `${traveler.shortCount} of ${traveler.rows.length} below target · ${storageCount} container(s)`
          : `all ${traveler.rows.length} at or above target · ${storageCount} container(s)`,
      },
      timestamp,
    }],
  };
}

/** Placeholder for a channel whose traveler has nothing to show yet. */
export function renderEmpty(name) {
  return {
    embeds: [{
      title: name,
      description: 'Nothing to show yet — add storage with `/storage add`.',
      color: COLOUR_OK,
      timestamp: new Date().toISOString(),
    }],
  };
}

/**
 * Stable fingerprint of one traveler's rendered content, so the poll only edits
 * when something changed. Excludes the timestamp, which would otherwise differ
 * every pass and defeat the check entirely.
 */
export function travelerHash(traveler) {
  return JSON.stringify([
    traveler.name,
    traveler.tiers,
    traveler.unconfigured.map((m) => m.key),
    traveler.rows.map((r) => [r.key, r.have, r.target]),
  ]);
}
