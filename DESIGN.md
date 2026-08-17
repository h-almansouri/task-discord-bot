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
refresh deliberately.

**One runtime exception:** the weekly rotation reminder (§9) needs
`traveler_task_loop_timer`, which is live and only available from a relay. That's a
single-row subscription checked a few times a day — negligible, but it does mean the
bot is not entirely relay-free at runtime.

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
   workaround is only needed when reading a relay directly — and the usual advice for
   doing it is wrong. Relay rows arrive as **JSON-encoded strings inside** the envelope:
   ```
   "inserts":["[49154,[1,[1787237181395131]]]"]
   ```
   Running the big-int regex over the whole message injects quotes *inside* that string
   and corrupts the envelope:
   ```
   "inserts":["[49154,[1,["1787237181395131"]]]"]   <- unparseable
   ```
   Parse the envelope first with no substitution, then apply the regex to each row string
   individually. This only looks harmless on `traveler_task_desc`, whose ids are 10
   digits, making the regex a no-op; on any table carrying u64 ids it destroys the
   payload.
6. **A claim costs one request** regardless of building count — 22 buildings arrived in a
   single 38 KB response.
7. **bitjita sets `cache-control: public, s-maxage=5`** on inventories, so ~5s is the
   freshness the source itself targets.
8. **Claim and player ids are region-agnostic.** Claims in regions 18 and 19 were fetched
   with no region parameter at all. Region never needs to be stored or supplied — it only
   comes back as metadata on the response.
9. **`expirationTimestamp` on the per-player traveler-tasks endpoint is not a global
   clock.** Eight citizens of one claim returned three different values, all in the past,
   the worst 134 days stale. It is a per-player snapshot frozen at that player's last
   sync. Use `traveler_task_loop_timer` from a relay instead.

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
  "reminder": { "roleId": "…", "hoursBefore": 24 },
  "storages": [
    { "type": "claim",  "id": "864691128488445884", "buildings": "all" },
    { "type": "claim",  "id": "…", "buildings": ["Alesi Tasks"] },
    { "type": "player", "id": "648518346360148383", "housing": true }
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

No region field — ids are region-agnostic *(verified)*. Region arrives as metadata on
responses and is only worth surfacing in `/storage list` for human recognition.

Building-level selection matters: a claim may hold Embergrain set aside for crafting that
nobody would ever turn in. Summing all buildings would count it and suppress a warning
you wanted.

Player storages include housing by default (`"housing": true`).

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
/config reminder @task-reminder 24h
/refresh
/rulebook refresh
```

---

## 8. Display

Shortfalls only — materials at or above target are not listed, and a traveler with no
shortfalls gets **no embed at all** rather than an "all stocked" placeholder. One embed
per traveler that has something to report, all inside one message, edited in place. When
nothing anywhere is short, the message says so in a single line.

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

### Weekly rotation reminder

Travelers reroll their tasks on a fixed schedule. The bot pings a configured role a
configurable interval before it happens (default 24h), as a **new message** — not an edit
of the tracker, since a silent edit is exactly what nobody notices.

The clock comes from `traveler_task_loop_timer` on a relay. A sample read:

```
[49154,[1,["1787237181395131"]]]        // scheduled_id, then micros since epoch
  -> 2026-08-20T14:46:21Z
```

Note the value is **microseconds**, and it exceeds `Number.MAX_SAFE_INTEGER`, so it needs
the per-row big-int handling from §4.

Do **not** use `expirationTimestamp` from the per-player traveler-tasks endpoint for this.
It is a stale per-player snapshot *(verified — see §4.9)*.

Poll the timer a few times a day, fire once per rotation, and persist which rotation was
last announced so a bot restart doesn't re-ping.

---

## 10. Resolved, and still open

Settled since the first draft:

- **Regions** — a non-issue. Ids are region-agnostic *(verified)*, so there is nothing to
  configure and nothing to "support at launch".
- **Housing** — included by default for player storages.
- **Travelers with no shortfalls** — omitted entirely, no placeholder.
- **Rotation reminder** — yes, pinging a configurable role a configurable time ahead
  (default 24h), driven by the relay timer. See §9.

Still open:

- **Does `/api/players/{id}/inventories` already include housing storage?** Unverified —
  `/housing` returned 404 for all nine players sampled, so no test case was available.
  If it does, `"housing": true` costs nothing extra; if not, it's a second request per
  player. Needs one player who actually owns a house.
- **What counts as a "material family"** for display grouping — Alesi's 50 materials are
  really 5 families × 10 tiers, and collapsing them would read far better than 50 flat
  rows. Needs a rule; tier is on `item_desc`, but family is only implied by name.
- **First-run friction for variable-qty materials** (§5): adding Ramparte does nothing
  until seven separate thresholds are set. Options are a sensible default, a setup
  prompt, or leaving them untracked until configured.
