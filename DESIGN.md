# BitCraft Traveler Supply Bot — Design

A Discord bot that watches chosen BitCraft storages and reports which **traveler task
materials** are running low, editing a single message in place.

Status: **built.** This document is the design the code follows, kept because its
findings explain choices the code alone cannot. Everything marked *verified* was tested
against live data (2026-08-16 unless dated otherwise).

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
10. **`item_desc.tag` is the material-family key.** It groups Alesi's 50 items into 5
    families, and correctly groups `Baitfish` (Briny Guppi, Muddy Guppi, Greenhorn Guppi,
    Azure Minni…) which share no common substring and would defeat any name-parsing rule.
11. **A player's storage is spread across two endpoints that do not overlap.**
    `/inventories` returned **19 containers** for one character: personal (Inventory,
    Toolbelt, Wallet), two deployables (a wagon and a bird), and bank slots in **14
    different claims** they are merely a citizen of. Their house's **35 containers** are
    not in that response at all — the house building id never appears as an owner. They
    come only from `/housing` → `/housing/{houseId}`, a 141 KB payload. Total selectable
    containers for that one character: **54**.
12. **House containers carry user-set nicknames in `buildingNickname`** — "Metal",
    "Logs", "Farming", "Seeds N Fert". These are the names a player actually recognises,
    and the only sane thing to show in a picker.
13. **There are three different pocket shapes**, not two:
    | Source | Pocket array | Contents keys |
    |---|---|---|
    | claim `/inventories` | `building.inventory[]` | `item_id`, `item_type` |
    | player `/inventories` | `inventories[].pockets[]` | `itemId`, `itemType` |
    | house `/housing/{id}` | `inventories[].inventory[]` | `item_id`, `item_type` |
    One normalizer, applied at the boundary, or counts silently read zero.
14. **A player's container list is not stable between fetches.** The same character
    returned 19 containers one hour and 17 the next — a wagon and a bird had gone,
    presumably dismissed in game. Containers are therefore matched by id and a tracked
    container may simply be absent from a later response. That is not an error, but
    `/storage list` should show when a tracked container has stopped appearing rather
    than quietly counting it as zero.
15. **Owner id alone does not identify personal storage.** A deployable (wagon, cart,
    bird) is owned by the deployable, not the player, so `ownerEntityId === playerId`
    files it alongside claim banks. Deployables are distinguished by having no
    `claimName`.
16. **Embed footer text is plain — no markdown, no timestamp tags.** A `<t:…:R>` tag
    placed there renders as literal characters. Use the embed's native `timestamp`
    field, which Discord renders beside the footer and localises per viewer.
17. **Components V2 was evaluated and rejected.** discord.js 14.27 supports it fully, and
    a working prototype validated, but the 40-component cap is the binding constraint
    rather than its 4,000-character budget: one Section per material family — the only
    layout giving a per-row icon — costs 42 components at just *two* travelers. Its one
    real advantage over embeds is therefore unusable here, while its text budget is a
    third smaller than the 6,000 embeds allow. Embeds already give one thumbnail per
    traveler, since the tracker renders one embed each.
18. **One `tag` can cover several product lines.** All 50 of Heimlich's materials are
    tagged `Basic Food`, but they are five foods across ten tiers, so five items share
    every tier. Repeated tiers are the signal: when a tag's tiers repeat, split it by the
    name after the tier adjective ("Plain/Savory/Zesty Cooked Berries" → "Cooked
    Berries"). When they don't repeat, leave it alone — Alesi's baitfish are ten
    different fish, one per tier, and splitting them would make ten families of one.
19. **Exactly one task in the catalogue requires currency.** Rumbagh's mystery shipment
    costs 1,000 Hex Coins, while 320 of 321 tasks *reward* coins. It is a purchase rather
    than something stockpiled, and coins sit in the wallet, so the `Coins` tag is excluded
    from materials.
20. **Item icons are available** at `https://bitjita.com/{iconAssetName}.webp` — note
    `.webp`, not `.png`. Coverage is incomplete: Salt's asset path is `Items/Salt` rather
    than `GeneratedIcons/…` and 404s, and only three of six travelers have a portrait
    (found via `npc_desc.prefab_address`, not the display name). If icons are ever used,
    resolve and validate the URLs when building the rulebook rather than per render.

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
guessing. To keep that from being invisible friction, `/traveler add` **prompts for the
numbers inline** when the traveler has variable-qty materials — so adding Ramparte walks
you through its seven, rather than silently tracking nothing. Skipping a prompt leaves
that material untracked and listed by `/traveler list`, never silently defaulted.

Only Svim (1) and Ramparte (7) trigger this. The other four travelers add in one step.

**Resolution order**, first match wins. A per-material number always wins; after that
the two kinds diverge, because turn-in maths only means something for one of them:

| | Fixed quantity | Varying quantity |
|---|---|---|
| 1 | per-material absolute (`/config threshold`) | per-material absolute (`/config threshold`) |
| 2 | per-material turn-ins | per-traveler default (`/config variable traveler:…`) |
| 3 | per-traveler tier band (`/config band traveler:…`) | global default (`/config variable`) |
| 4 | per-traveler turn-ins (`/config turnins traveler:…`) | *awaiting a threshold* |
| 5 | global tier band (`/config band`) | |
| 6 | global turn-ins (`/config turnins`) | |

### Tier bands

A band sets turn-ins for a tier range — "250 turn-ins for T1–T4". It holds a **turn-in
count, not an amount**, so what it costs varies by material:

| Material | Per turn-in | × 250 turn-ins |
|---|---|---|
| Rumbagh Brick | 10 | 2,500 |
| Rumbagh Plank | 20 | 5,000 |
| Alesi Plant Fiber | 300 | 75,000 |

That is the intent: a band says how many turn-ins' worth to keep, whatever that costs.
`/config band` echoes the resulting range back so the scale is visible before it
surprises anyone.

Bands never apply to Ramparte, and need no special case to avoid him: **all 15 of his
materials are untiered** (tier −1), so no band can match them and they fall through to
the varying-quantity default.

The varying-quantity defaults exist because setting Ramparte's seven combat drops one at
a time is tedious when one figure suits all of them. A default of `0` is honoured as
"never flag this" rather than treated as unset. With no default anywhere, the material is
still reported as unconfigured rather than guessed at.

### Switching materials off

Some families are not worth watching — Rumbagh's Experimental Compounds, say. Two
granularities, because they answer different questions:

| | Command | Effect |
|---|---|---|
| A whole family | `/traveler ignore` | drops all ten tiers at once |
| A single tier | `/config threshold <material> 0` | that one material is never short |

Exclusions are stored per traveler as family names, so ignoring a family for Rumbagh
leaves it watched for anyone else who wants it. They also suppress the
awaiting-a-threshold warning: ignoring Salt stops Svim asking for a number for it.

---

## 6. Configuration

Per guild. JSON file to start; SQLite only if multi-guild becomes real.

```jsonc
{
  "channelId": "…",
  "messageId": "…",                 // the message edited in place
  "reminder": { "roleId": "…", "hoursBefore": 24 },
  "storages": [
    {
      "source": { "type": "player", "id": "1369094286781181638", "name": "Velcruza" },
      "containers": [                       // explicit; ids are authoritative
        { "id": "1369094288186713242", "name": "Logs",    "from": "house" },
        { "id": "…",                   "name": "Metal",   "from": "house" },
        { "id": "…",                   "name": "Farming", "from": "house" }
      ]
    },
    {
      "source": { "type": "claim", "id": "864691128488445884", "name": "Mystic Embassy" },
      "containers": [
        { "id": "…", "name": "Alesi Tasks", "from": "claim" }
      ]
    }
  ],
  "travelers": {
    // Each traveler owns one message. channelId is optional — without it the
    // traveler posts in the guild default above.
    "Alesi": { "tiers": [1, 5], "channelId": "…", "messageId": "…" },
    "Svim":  { "tiers": [1, 3] },
    "Rumbagh": {
      "tiers": [1, 10],
      "excluded": ["Experimental Compounds"]   // whole family, every tier
    }
  },
  "tierBands": [
    { "tiers": [1, 4], "turnIns": 250 },
    { "tiers": [5, 6], "turnIns": 500 }
  ],
  "turnIns": 5,
  "variableDefault": 25,              // blanket target for varying-qty materials
  "overrides": {
    "Alesi":    { "turnIns": 8 },
    "Ramparte": { "variableDefault": 5 }
  },
  "absolute":  { "item:1110015": 500 }   // Salt, beats every default
}
```

No region field — ids are region-agnostic *(verified)*. Region arrives as metadata on
responses and is only worth surfacing in `/storage list` for human recognition.

**Containers are always chosen explicitly — there is no default set.** One character had
54 of them across personal slots, a wagon, a bird, 14 claim banks and 35 house chests
*(verified, §4.11)*. No default could guess usefully among those, and a wrong guess
silently counts stock in other people's towns and suppresses warnings you wanted.

Names are stored alongside ids purely for display; the **id is authoritative**, so
renaming a chest in game doesn't break tracking. `/storage list` should show a container
whose name has drifted, since that's a signal the layout changed.

---

## 7. Commands

```
/setup channel #channel
/storage add "Velcruza"           # player or claim name -> container picker
/storage add "Mystic Embassy"
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

### The `/storage add` flow

One command for both players and claims — the bot works out which the name is.

1. `/storage add "Velcruza"` — resolve the name via `/api/players?q=` and
   `/api/claims?q=`. If it matches both, or several, disambiguate first.
2. Fetch every container that source has. For a player that means `/inventories` **and**
   `/housing` → `/housing/{houseId}` per house, since they don't overlap *(§4.11)*.
3. Present them all in an ephemeral message, grouped by origin and labelled with the name
   the player would recognise — `buildingNickname` where set *(§4.12)*.
4. User multi-selects. Only the chosen containers are stored.

Real listing for one character:

```
Personal          3   Inventory · Toolbelt · Wallet
House            35   Metal · Logs · Planks · Leather · Cloth · Foraging · Fishing ·
                      Farming · Seeds N Fert · Raw Mats · Foods · Dropbox · …
Wagons & mounts   2   Velcruza's Wagon (III) · Velcruza's Bird (I)
Claim banks      14   Amberfall · Aurelia · Murwent · Notsolis · Oceansky City · …
```

**Discord caps a select menu at 25 options**, and 54 containers exceeds that. The picker
therefore asks for an **origin group first** — personal / banks / house — then lists
within it. Paging is only added if a single group exceeds 25, which today only `house`
could (35 for the test character). Group-first is the better default regardless: paging a
flat list of 35 similarly-named chests is miserable to use.

---

## 8. Display

**One message per traveler**, each optionally in its own channel, so people can follow
what they care about and mute the rest. Every watched material is shown, stocked or not:
seeing that Cloth is fine through T5 and falls off at T6 is the point.

The body is a **family × tier grid inside an ANSI code block**. Discord renders colour
inside ` ```ansi ` fences, and monospace is what makes the columns line up. Surplus is
green, shortfall red, and a tier a family does not have is a grey dash rather than a
blank — Rumbagh's Ink stops at T8, and an empty cell would read as "you have none".

Untiered materials — Ramparte's combat drops — have no axis to grid against, so they
render as a list sorted worst-first.

**Tiers are split into blocks of five, one embed each.** A ten-tier grid is 76 columns
and wraps inside an embed even on desktop — embeds are narrower than plain message
content, and their width cannot be set. Five tiers is 46 columns with margin to spare.
Each block is coloured independently, so a green T1–5 beside a red T6–10 shows where the
work is at a glance.

Cells are six characters wide. Five is too narrow: abbreviated values reach five
characters (`+1.3k`) and neighbours end up touching — `+1.3k+1.4k` — which is unreadable.

This is tuned for **desktop**; the grid will still wrap on a phone, which was an accepted
trade.

Rows are **grouped by `item_desc.tag`**, with tiers collapsed onto one line per family.
Real output, Alesi at tiers 1–5 and 5 turn-ins, against a live claim:

```
Rumbagh · T1–5                                    [green when the block is clear]
MATERIAL            T1    T2    T3    T4    T5
Parchment          -82  +710  -122   -77  -400
Brick             -194   +13   +31  -192  -400
Plank             +842 +1.1k  +715   -76  -559
Ingot            +1.3k +1.4k +1.8k +1.8k    +1
[15 of 35 below target]

Rumbagh · T6–10
MATERIAL            T6    T7    T8    T9   T10
Parchment         -400   -50   -50   -50   -50
Ink               -400   -50   -50     -     -
Plank             -796  -100  -100  -100  -100
[48 of 68 below target · 35 container(s)]
```

Values are abbreviated past 1,000 (`-6.0k`) because tier bands push targets into five and
six figures, and an unabbreviated number would break the grid. Signs carry the meaning
where colour cannot: `+` surplus, `-` short.

Only the last embed carries the clock and the overall count; repeating either on every
block is noise. Any threshold warning lands there too.

Real sizes: Rumbagh at ten tiers and seven families is **1,655 characters across two
embeds**, 46 columns wide. Limits are per *message*, not per bot or channel, so giving
each traveler its own message means none of them compete for room.

The timestamp is the embed's native `timestamp` field, never a `<t:…>` tag in the footer
(§4.16).

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

The clock comes from `traveler_task_loop_timer` on a relay — a single row, columns
`scheduled_id, scheduled_at`. The `scheduled_at` payload differs by relay *(verified
2026-08-22)*:

```
bitjita        [1,["1787841981396070"]]
bitcraftsync   [1,{"__timestamp_micros_since_unix_epoch__":"1787841981396070"}]
  -> 2026-08-27T14:46:21Z
```

Tag 1 is an absolute time (tag 0 would be an interval, which a snapshot cannot anchor).
Successive readings were exactly **604,800s apart** — the weekly cadence — with
`scheduled_id` incrementing by one per rotation. Note the value is **microseconds**. At
16 digits it trips the per-row big-int quoting from §4 and so arrives as a *string*;
convert with `BigInt`. (Contrary to an earlier claim here, today's values are still
below `Number.MAX_SAFE_INTEGER` — the quoting is what makes them strings, not overflow.)

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

- **Material families** — `item_desc.tag` is the grouping key (§4.10, §8).
- **Variable-qty friction** — `/traveler add` prompts for the numbers inline (§5).

- **Housing** — resolved: it is a **separate** request, not covered by `/inventories`
  (§4.11). A player with a house costs `1 + 1 + houses` requests rather than 1.
- **Container selection** — always explicit, via a picker. No defaults (§7).

- **Picker layout** — group first (personal / banks / house), page only if one group
  exceeds 25 (§7).
- **Housing refresh cost** — a non-issue at realistic scale. Expected usage is at most
  ~3 tracked players. Cache each player's house *list* and refetch only
  `/housing/{houseId}` for contents: 2 requests per player per poll. Three players plus a
  claim is ~21 requests/min against a 250/min limit, and roughly 420 KB per poll. Revisit
  only if someone tracks players in double digits.

Nothing blocking remains. What's left is a hosting decision, not code.
