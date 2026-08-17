# BitCraft Traveler Supply Bot — Design

A Discord bot that watches chosen BitCraft storages and reports which **traveler task
materials** are running low, editing a single message in place.

Status: **design only.** No bot code exists yet. Everything below marked *verified* was
tested against live data on 2026-08-16; everything else is a proposal open to change.

---

## 1. What it does

You tell the bot which storages hold your traveler supplies and which travelers you care
about. It compares what's in those storages against what those travelers can ask for, and
posts a live-updating list of shortfalls.

It is **traveler-oriented, not player-oriented**. It does not track any individual's
currently-rolled tasks. Alesi *can* ask for Embergrain, so you keep Embergrain stocked —
regardless of who has rolled what this week.

---

## 2. Core model

Each traveler has a fixed pool of tasks. Each task requires a specific quantity of a
specific item. *(verified)*

| Traveler | Skill | Tasks | Materials | of which variable-qty |
|---|---|---|---|---|
| Rumbagh | 19 | — | 79 | 0 |
| Svim | 21 | — | 67 | 1 |
| Brico | 15 | — | 50 | 0 |
| Alesi | 17 | 50 | 50 | 0 |
| Heimlich | 13 | — | 50 | 0 |
| Ramparte | 18 | — | 15 | 7 |
| The Twins | — | 0 | 0 | — |
| **Total** | | **321** | **311** | **8** |

Alesi is the clearest shape — 5 material families × 10 tiers:

| Family | Per turn-in | Tiers |
|---|---|---|
| Plant Fiber | 300 | 1–10 |
| Embergrain | 200 | 1–10 |
| Starbulb | 30 | 1–10 |
| Healing Potion | 5 | 1–10 |
| Fish (bait) | 10 | 1–10 |

### The task → traveler join

`traveler_task_desc` has **no traveler column**. The link is: *(verified)*

```
traveler_task_desc.level_requirement.skill_id  →  npc_desc.task_skill_check
```

Verified across all 321 tasks, with zero mismatches against the traveler named in each
task's own description text. Skills 13, 15, 17, 18, 19 and 21 each map to exactly one
traveler; no skill is shared.

---

## 3. Data sources

Two sources, because they hold different things — not because one is better.

| | Source | Shape | Cadence |
|---|---|---|---|
| **Rulebook** — every task each traveler can give, plus item names | relay websocket | SpacetimeDB tables | fetched on demand by a script, cached to a repo file |
| **Live stock** — what's actually in your chests | bitjita HTTP | plain JSON | polled every 20s |

### Rulebook

Tables: `traveler_task_desc` (321), `npc_desc` (7), `item_desc` (8,281), `cargo_desc` (636).
The bitjita REST API does not expose these; only a relay does. *(verified)*

This is static game data that changes on patches. We fetch it once, commit the result, and
refresh deliberately. The bot never touches a relay at runtime.

Primary **relay.bitjita.com**, fallback **relay.bitcraftsync.app**:

| | relay.bitjita.com | relay.bitcraftsync.app |
|---|---|---|
| Ports | 443 only, region in path | one per region (3000+N) |
| Fronted by | Cloudflare | direct |
| Row encoding | positional arrays | named objects |

Both carry identical content — all 321 shared tasks have matching `(item_id, quantity)`
requirements. *(verified)* The rulebook is also **byte-identical across regions 7, 11, 12
and 23**, so any region will do. *(verified)*

### Live stock

- `GET /api/claims/{id}/inventories` — all buildings in a claim, with names and nicknames
- `GET /api/players/{id}/inventories` — player and housing storage
- `GET /api/claims?q=` / `GET /api/players?q=` — name → id lookup for setup

Rate limit 250 req/min. Send a `User-Agent` or `x-app-identifier` header.

---

## 4. Verified findings worth keeping

Discovered during the spike; several contradict widely-circulated advice.

1. **Node connects to both relays with no special handling.** Node 24.15's built-in
   `WebSocket` opens the socket and negotiates `v1.json.spacetimedb`. The
   `SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION` / manual-upgrade workaround is obsolete.
2. **The two relays encode rows differently.** Same task, same data:
   ```
   bitcraftsync  {"id":1805868417,"level_requirement":{"skill_id":15,...
   bitjita       [1805868417,[15,1,120],[[1200,1,[1,[]],[1,[]]]],...
   ```
   Supporting both needs a positional→named decoder driven by
   `/v1/database/bitcraft-live-N/schema?version=9`, whose column order matches the array
   order exactly. This is the same decoder needed for delta updates, should we ever want
   live relay data.
3. **bitjita's two inventory endpoints disagree on field naming.** Claim responses use
   `building.inventory[]` with `contents.item_id` / `item_type`; player responses use
   `inventories[].pockets[]` with `contents.itemId` / `itemType`. Normalize at the
   boundary or lookups silently return zero.
4. **The `items` map in a response is not a full catalogue.** One claim held 131 distinct
   items but returned only 119 names. Resolve names from the cached rulebook instead.
5. **u64 entity ids** come back from bitjita already as JSON strings. The regex-quoting
   workaround is only needed when reading a relay directly.
6. **A claim costs one request** regardless of building count — 22 buildings arrived in a
   single 38 KB response.
7. **bitjita sets `cache-control: public, s-maxage=5`** on inventories, so ~5s is the
   freshness the source itself targets.

---

## 5. Thresholds

Two kinds of material. *(verified: 303 fixed, 8 variable)*

**Fixed-quantity** — every task asking for it wants the same amount.

```
target = turnIns × quantityPerTurnIn
```

With `turnIns = 5`, Alesi's Embergrain target is 5 × 200 = 1,000 per tier.

**Variable-quantity** — asked for at several different amounts, so turn-in maths is
meaningless. These take a plain absolute number instead. All eight:

| Traveler | Material | Quantities seen |
|---|---|---|
| Svim | Salt | 10, 15, 20 … 55 |
| Ramparte | Jakyl Fur | 1, 5, 10 |
| Ramparte | Umbura Fang | 1, 5 |
| Ramparte | Hardened Shell | 1, 5 |
| Ramparte | Jakyl Fang | 1, 5 |
| Ramparte | Ancient Skitch Shell | 1, 5 |
| Ramparte | Crystalized Slime | 1, 5 |
| Ramparte | Deadly Stinger | 1, 5 |

The bot should **refuse to track a variable material until a number is set**, rather than
guessing.

**Resolution order**, first match wins:

1. Per-material absolute number
2. Per-material turn-ins override
3. Per-traveler turn-ins override
4. Global turn-ins default

---

## 6. Configuration

Per guild. JSON file to start; SQLite only if multi-guild becomes real.

```jsonc
{
  "channelId": "…",
  "messageId": "…",                 // the message edited in place
  "storages": [
    { "type": "claim",  "id": "864691128488445884", "region": 12, "buildings": "all" },
    { "type": "claim",  "id": "…", "region": 12, "buildings": ["Alesi Tasks"] },
    { "type": "player", "id": "648518346360148383", "region": 12 }
  ],
  "travelers": {
    "Alesi": { "tiers": [1, 5] },
    "Svim":  { "tiers": [1, 3] }
  },
  "turnIns": 5,
  "overrides": { "Alesi": { "turnIns": 8 } },
  "absolute":  { "0:1110015": 500 }   // Salt
}
```

Storages are region-scoped; bitjita returns `regionId` on every inventory response.

Building-level selection matters: a claim may hold Embergrain set aside for crafting that
nobody would ever turn in. Summing all buildings would count it and suppress a warning
you wanted.

---

## 7. Commands

```
/setup channel #channel
/storage add claim "Mystic Embassy"
/storage add claim "Mystic Embassy" building "Alesi Tasks"
/storage add player "Bob"
/storage list | /storage remove <n>
/traveler add Alesi tiers 1-5
/traveler list | /traveler remove Alesi
/config turnins 5
/config turnins Alesi 8
/config threshold Salt 500
/refresh
/rulebook refresh
```

---

## 8. Display

Shortfalls only — materials at or above target are not listed. One embed per tracked
traveler, all inside one message, edited in place.

The binding constraint is Discord's **6,000 characters across all embeds** — not the
4,096-per-description limit, which is never reached first. At roughly 50 characters per
line that is about 100 shortfall lines total. With tier ranges scoped this is comfortable;
beyond it, truncate per traveler with a `+N more` line rather than letting the edit fail.

```
Alesi · tiers 1-5 · 5 turn-ins
  Rough Plant Fiber      T1     140 / 1500   short 1360
  Basic Embergrain       T1   4 005 / 1000   ok
  Simple Starbulb        T2       0 /  150   short 150
```

---

## 9. Polling

- Poll every **20s**. Well inside bitjita's own 5s cache, so not stale and not wasteful.
- **Only call `edit()` when the rendered output changed.** At 20s, without this guard an
  active hauling session would edit three times a minute for hours. A quiet claim should
  cost zero Discord calls.
- Headroom: one request per claim or player per cycle. At 20s that's 3/min each, so ~83
  storages before approaching bitjita's 250/min. Discord's edit limit (~5 per 5s per
  channel) is never near.

If sub-20s freshness is ever wanted, that is the point where a live relay subscription
starts to earn its complexity. Not before.

---

## 10. Open questions

- Which region(s) to support at launch — config allows several, untested across more
  than one.
- Whether `/storage add player` should include housing storage by default.
- What to show when a traveler has no shortfalls: omit the embed, or show "all stocked"?
- Whether to warn when the weekly task rotation resets (`expirationTimestamp` is
  available on the per-player endpoint, though the bot is not player-oriented).
