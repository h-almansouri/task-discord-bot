/**
 * Build the rulebook: every task each traveler can give, and the materials it wants.
 *
 * `traveler_task_desc` has no traveler column. The join runs through the task's
 * required skill (DESIGN.md §2):
 *
 *   traveler_task_desc.level_requirement.skill_id -> npc_desc.task_skill_check
 */
import { skillIdOf, requirementsOf } from '../relay/decode.mjs';
import { itemKey } from '../stock/normalize.mjs';

export const RULEBOOK_TABLES = ['traveler_task_desc', 'npc_desc', 'item_desc', 'cargo_desc'];

/**
 * The words every name in a family ends with — "Basic Starbulb", "Fine Starbulb"
 * and so on share "Starbulb". Returns '' when there is no shared ending.
 */
export function commonTrailingWords(names) {
  if (!names.length) return '';
  const words = names.map((n) => String(n).trim().split(/\s+/));
  const shortest = Math.min(...words.map((w) => w.length));
  const tail = [];
  for (let i = 1; i <= shortest; i++) {
    const word = words[0][words[0].length - i];
    if (!words.every((w) => w[w.length - i] === word)) break;
    tail.unshift(word);
  }
  return tail.join(' ');
}

/**
 * A label a player would recognise for a material family.
 *
 * `item_desc.tag` groups correctly but is sometimes the internal category
 * rather than the thing itself — Starbulb is tagged "Vegetable". The member
 * names usually share the real name, so prefer that. Families whose members
 * share nothing (Baitfish: Briny Guppi, Azure Minni, Divine Tetra…) keep the
 * tag, which is the only sensible label for them.
 */
export function familyLabel(tag, names) {
  const shared = commonTrailingWords(names);
  if (!shared) return tag || 'Other';

  // A derived label that only trims words off the front of the tag is less
  // informative, not more: "Oceanfish Scale" must not collapse to "Scale".
  // "Starbulb" from tag "Vegetable" is fine — it is not a trim, it is a name.
  const t = String(tag ?? '');
  if (t && shared.length < t.length && t.toLowerCase().endsWith(shared.toLowerCase())) {
    return t;
  }
  return shared;
}

export function buildRulebook({ traveler_task_desc, npc_desc, item_desc, cargo_desc }, meta = {}) {
  const items = new Map();
  for (const it of item_desc ?? []) {
    items.set(itemKey('item', it.id), { name: it.name, tier: it.tier, tag: it.tag });
  }
  for (const c of cargo_desc ?? []) {
    items.set(itemKey('cargo', c.id), { name: c.name, tier: c.tier, tag: c.tag });
  }

  // skill -> traveler. Travelers with no task skills (The Twins) give no tasks.
  const travelerBySkill = new Map();
  for (const npc of npc_desc ?? []) {
    for (const skill of npc.task_skill_check ?? []) {
      if (travelerBySkill.has(skill)) {
        throw new Error(`skill ${skill} claimed by both ${travelerBySkill.get(skill).name} and ${npc.name}`);
      }
      travelerBySkill.set(skill, npc);
    }
  }

  // traveler -> itemKey -> quantities seen
  const perTraveler = new Map();
  let unmapped = 0;
  for (const task of traveler_task_desc ?? []) {
    const npc = travelerBySkill.get(skillIdOf(task));
    if (!npc) { unmapped++; continue; }
    const entry = perTraveler.get(npc.name) ?? { npc, tasks: 0, mats: new Map() };
    perTraveler.set(npc.name, entry);
    entry.tasks++;
    for (const req of requirementsOf(task)) {
      const key = itemKey(req.itemType, req.itemId);
      const m = entry.mats.get(key) ?? { quantities: [], taskCount: 0 };
      entry.mats.set(key, m);
      m.quantities.push(req.quantity);
      m.taskCount++;
    }
  }

  const travelers = {};
  for (const [name, entry] of perTraveler) {
    const materials = [];
    for (const [key, m] of entry.mats) {
      const distinct = [...new Set(m.quantities)].sort((a, b) => a - b);
      const info = items.get(key);
      materials.push({
        key,
        name: info?.name ?? `<${key}>`,
        tier: info?.tier ?? null,
        tag: info?.tag ?? null,
        taskCount: m.taskCount,
        quantities: distinct,
        // A single quantity means turn-in maths applies. Several means the user
        // must set an absolute threshold instead (DESIGN.md §5).
        fixed: distinct.length === 1,
        perTurnIn: distinct.length === 1 ? distinct[0] : null,
      });
    }
    // Name each family from its members, so the tracker shows "Starbulb" rather
    // than the "Vegetable" tag that happens to group them.
    const byTag = new Map();
    for (const m of materials) {
      const list = byTag.get(m.tag) ?? [];
      byTag.set(m.tag, list);
      list.push(m);
    }
    for (const [tag, list] of byTag) {
      const label = familyLabel(tag, list.map((m) => m.name));
      for (const m of list) m.family = label;
    }

    materials.sort((a, b) => (a.tag ?? '').localeCompare(b.tag ?? '') || (a.tier ?? 0) - (b.tier ?? 0));
    travelers[name] = {
      npcType: entry.npc.npc_type,
      skills: entry.npc.task_skill_check ?? [],
      taskCount: entry.tasks,
      materials,
    };
  }

  const referenced = {};
  for (const t of Object.values(travelers)) {
    for (const m of t.materials) if (items.has(m.key)) referenced[m.key] = items.get(m.key);
  }

  return {
    generatedAt: meta.generatedAt ?? null,
    source: meta.source ?? null,
    region: meta.region ?? null,
    counts: {
      tasks: traveler_task_desc?.length ?? 0,
      tasksUnmapped: unmapped,
      travelers: Object.keys(travelers).length,
      items: item_desc?.length ?? 0,
      cargo: cargo_desc?.length ?? 0,
    },
    travelers,
    items: referenced,
  };
}

/** Cross-check the skill join against the traveler named in each description. */
export function verifyJoin(tasks, npcs) {
  const bySkill = new Map();
  for (const npc of npcs) for (const s of npc.task_skill_check ?? []) bySkill.set(s, npc.name);
  const names = npcs.map((n) => n.name);
  let checked = 0, mismatched = 0, unmapped = 0;
  for (const task of tasks) {
    const viaSkill = bySkill.get(skillIdOf(task));
    if (!viaSkill) { unmapped++; continue; }
    const spoken = names.find((n) => typeof task.description === 'string' && task.description.startsWith(n));
    if (!spoken) continue;
    checked++;
    if (spoken !== viaSkill) mismatched++;
  }
  return { checked, mismatched, unmapped };
}
