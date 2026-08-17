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

/** One family, collapsed to a single line when every tier shares a target. */
export function renderGroup(group) {
  const tiered = group.rows.filter((r) => r.tier != null && r.tier >= 1);

  if (group.uniformTarget != null && tiered.length === group.rows.length && group.rows.length > 1) {
    const head = group.perTurnIn
      ? `\`${group.tag}\` — ${num(group.perTurnIn)}/turn-in · target ${num(group.uniformTarget)}/tier`
      : `\`${group.tag}\` — target ${num(group.uniformTarget)}/tier`;
    const short = group.rows.map((r) => `T${r.tier} **${num(r.short)}**`).join(' · ');
    return `${head}\n   short: ${short}`;
  }

  // Mixed targets, or untiered materials like combat drops — one line each.
  return group.rows.map((r) => {
    const label = r.tier != null && r.tier >= 1 ? `${r.name} (T${r.tier})` : r.name;
    return `\`${label}\` — ${num(r.have)} / ${num(r.target)} · short **${num(r.short)}**`;
  }).join('\n');
}

function travelerEmbed(traveler) {
  const parts = traveler.groups.map(renderGroup);

  if (traveler.unconfigured.length) {
    const names = traveler.unconfigured.map((m) => m.name).join(', ');
    parts.push(
      `\n⚠️ ${traveler.unconfigured.length} material(s) need a threshold before they can be ` +
      `tracked: ${names.length > 300 ? `${names.slice(0, 297)}…` : names}\n` +
      'Set one with `/config threshold`.',
    );
  }

  const tiers = traveler.tiers ? ` · tiers ${traveler.tiers[0]}–${traveler.tiers[1]}` : '';
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
  const stamp = updatedAt ? `updated <t:${Math.floor(updatedAt / 1000)}:R>` : 'updated just now';
  const footer = { text: `${storageCount} container(s) tracked` };

  if (!result.anyTracked) {
    return {
      embeds: [{
        title: 'Traveler supply',
        description: 'No travelers tracked yet. Add one with `/traveler add`.',
        color: COLOUR_OK,
        footer,
      }],
    };
  }

  if (!result.travelers.length) {
    return {
      embeds: [{
        title: 'Traveler supply — all stocked',
        description: `Every tracked material is at or above target.\n${stamp}`,
        color: COLOUR_OK,
        footer,
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

  const summary = `${result.totalShort} material(s) below target · ${stamp}` +
    (dropped ? ` · ${dropped} traveler(s) omitted for length` : '');
  if (embeds.length) {
    embeds[embeds.length - 1].footer = { text: `${summary} · ${footer.text}` };
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
