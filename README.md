# BitCraft Traveler Supply Bot

A Discord bot that watches chosen BitCraft storages and reports which **traveler task
materials** are running low, editing a single message in place.

It is traveler-oriented, not player-oriented: Alesi *can* ask for Embergrain, so you keep
Embergrain stocked — regardless of who has rolled what this week.

- **[SETUP.md](SETUP.md)** — get it running in your server
- **[DESIGN.md](DESIGN.md)** — the model, data sources, and verified findings

## Status

Feature-complete: everything below works end to end. Hosting is the open question.

| | |
|---|---|
| Rulebook fetcher (relay, both encodings) | done |
| Stock normalizer (three endpoint shapes) | done |
| Discord connection + `/travelers`, `/traveler` | done |
| Storage picker + per-guild config (`/storage`) | done |
| Thresholds, tier bands, live per-traveler tracker | done |
| Weekly rotation reminder | done |

## Commands

```bash
npm install
npm run rulebook     # fetch game data -> data/rulebook.json
npm run commands     # register slash commands with Discord
npm start            # run the bot
npm test             # data layer only, no Discord needed
```

## How the data works

Two sources, because they hold different things:

| | Source | Cadence |
|---|---|---|
| **Rulebook** — every task each traveler can give | relay websocket | on demand, committed to `data/` |
| **Live stock** — what's in your chests | bitjita HTTP | polled every 20s |

The rulebook is static game data that changes on patches, so the bot reads a committed
file rather than a relay. See DESIGN.md §3.

## Layout

```
src/relay/decode.mjs      envelope + row parsing, positional -> named
src/relay/client.mjs      one-shot snapshot reads, with relay fallback
src/rulebook/build.mjs    task -> traveler join, material classification
src/rulebook/load.mjs     read the committed rulebook
src/stock/bitjita.mjs     REST client for live storage
src/stock/normalize.mjs   the three container shapes -> one
src/stock/discover.mjs    container discovery, grouping, paging
src/stock/fetch.mjs       stock for tracked containers only
src/tracker/thresholds.mjs  target resolution, tier ranges
src/tracker/shortfall.mjs   stock vs target
src/tracker/render.mjs      embeds, within the 6000-char budget
src/tracker/poll.mjs        the 20s loop, edit-on-change
src/reminder/rotation.mjs   reroll clock parsing, the ping window
src/reminder/poll.mjs       relay reads a few times a day, ping once per rotation
src/config/store.mjs      per-guild config, serialised writes
src/commands/             slash commands and component routing
src/bot.mjs               entry point
```

Data from community projects: [bitjita](https://bitjita.com) and
[bitcraftsync](https://relay.bitcraftsync.app). Both are public and run by volunteers —
the rulebook is cached rather than refetched partly to keep load off them.
