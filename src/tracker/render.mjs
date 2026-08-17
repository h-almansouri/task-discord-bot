/**
 * Rendering the tracker message.
 *
 * Returns plain embed objects rather than builders, so this can be tested
 * without a gateway. discord.js accepts either.
 *
 * The binding constraint is Discord's 6,000-character budget across *all*
 * embeds — not the 4,096-per-description limit, which is never hit first
 * (DESIGN.md §8). Exceeding it makes the edit fail outright, so the budget is
 * enforced here rather than hoped for.
 */
const TOTAL_BUDGET = 6000;
const SAFETY_MARGIN = 200;   // headroom for the footer and any rounding
const COLOUR_SHORT = 0xd9534f;
const COLOUR_OK = 0x5cb85c;

/** Discord counts title, description, footer, author and field text together. */
export function embedLength(embed) {
  return (embed.title?.length ?? 0)
    + (embed.description?.length ?? 0)
    + (embed.footer?.text?.length ?? 0)
    + (embed.author?.name?.length ?? 0)
    + (embed.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);
}

const num = (n) => n.toLocaleString('en-US');

const isTiered = (row) => row.tier != null && row.tier >= 1;

/**
 * One family. Every number shown is a deficit, which the embed footer states
 * once, so rows carry no repeated "short" label — with a dozen families that
 * word alone was costing a line's worth of width each time.
 */
export function renderGroup(group) {
  const allTiered = group.rows.every(isTiered);

  if (group.uniformTarget != null && allTiered) {
    const head = `**${group.tag}** · ${num(group.uniformTarget)}/tier`;
    const cells = group.rows.map((r) => `T${r.tier} −${num(r.short)}`).join(' · ');
    // A lone tier reads better on one line than split across two.
    return group.rows.length === 1 ? `${head} · ${cells}` : `${head}\n${cells}`;
  }

  // Mixed targets, or untiered materials like combat drops — one line each.
  return group.rows.map((r) => {
    const label = isTiered(r) ? `${r.name} (T${r.tier})` : r.name;
    return `**${label}** · ${num(r.have)}/${num(r.target)} · −${num(r.short)}`;
  }).join('\n');
}

function travelerEmbed(traveler) {
  const parts = traveler.groups.map(renderGroup);

  if (traveler.unconfigured.length) {
    const names = traveler.unconfigured.map((m) => m.name).join(', ');
    parts.push(
      `⚠️ Needs a threshold: ${names.length > 200 ? `${names.slice(0, 197)}…` : names} ` +
      '· set with `/config threshold`',
    );
  }

  const tiers = traveler.tiers ? ` · T${traveler.tiers[0]}–${traveler.tiers[1]}` : '';
  return {
    title: `${traveler.name}${tiers}`,
    description: parts.join('\n'),
    color: traveler.shortCount ? COLOUR_SHORT : COLOUR_OK,
  };
}

/** Trim an embed's description to fit, noting what was cut. */
function truncateTo(embed, allowance) {
  const overhead = embedLength(embed) - (embed.description?.length ?? 0);
  const room = allowance - overhead;
  if (room <= 0) return null;

  const lines = embed.description.split('\n');
  const kept = [];
  let used = 0;
  const NOTE = '\n… truncated to fit Discord’s limit';
  for (const line of lines) {
    if (used + line.length + 1 + NOTE.length > room) break;
    kept.push(line);
    used += line.length + 1;
  }
  if (!kept.length) return null;
  return { ...embed, description: kept.join('\n') + NOTE };
}

/**
 * Build the tracker message.
 *
 * @param result   output of computeShortfalls
 * @param options  { updatedAt, storageCount }
 */
export function renderTracker(result, { updatedAt = null, storageCount = 0 } = {}) {
  // Discord renders this natively beside the footer and localises it per viewer.
  // A <t:…> tag cannot be used here: footer text is plain, so the tag would show
  // literally rather than as a time.
  const timestamp = new Date(updatedAt ?? Date.now()).toISOString();
  const footer = { text: `${storageCount} container(s) tracked` };

  if (!result.anyTracked) {
    return {
      embeds: [{
        title: 'Traveler supply',
        description: 'No travelers tracked yet. Add one with `/traveler add`.',
        color: COLOUR_OK,
        footer,
        timestamp,
      }],
    };
  }

  if (!result.travelers.length) {
    return {
      embeds: [{
        title: 'Traveler supply — all stocked',
        description: 'Every tracked material is at or above target.',
        color: COLOUR_OK,
        footer,
        timestamp,
      }],
    };
  }

  const embeds = [];
  let used = 0;
  let dropped = 0;

  for (const traveler of result.travelers) {
    const embed = travelerEmbed(traveler);
    const length = embedLength(embed);

    if (used + length <= TOTAL_BUDGET - SAFETY_MARGIN) {
      embeds.push(embed);
      used += length;
      continue;
    }

    // Try to fit a trimmed version; otherwise count it as dropped.
    const trimmed = truncateTo(embed, TOTAL_BUDGET - SAFETY_MARGIN - used);
    if (trimmed) {
      embeds.push(trimmed);
      used += embedLength(trimmed);
    } else {
      dropped++;
    }
  }

  const summary = `${result.totalShort} below target · ${footer.text}` +
    (dropped ? ` · ${dropped} traveler(s) omitted for length` : '');
  if (embeds.length) {
    const last = embeds[embeds.length - 1];
    last.footer = { text: summary };
    last.timestamp = timestamp;
  }

  return { embeds };
}

/**
 * Stable fingerprint of the rendered content, so the poll only edits when
 * something actually changed. Excludes the relative timestamp, which would
 * otherwise differ on every pass and defeat the check entirely.
 */
export function contentHash(result) {
  const shape = result.travelers.map((t) => [
    t.name,
    t.unconfigured.map((m) => m.key),
    t.groups.map((g) => [g.tag, g.rows.map((r) => [r.key, r.have, r.target])]),
  ]);
  return JSON.stringify(shape);
}
