# BitCraft Traveler Supply Bot

A Discord bot that watches chosen BitCraft storages and reports which **traveler task
materials** are running low, editing a single message in place.

It is traveler-oriented, not player-oriented: Alesi *can* ask for Embergrain, so you keep
Embergrain stocked — regardless of who has rolled what this week.

- **[SETUP.md](SETUP.md)** — get it running in your server
- **[DESIGN.md](DESIGN.md)** — the model, data sources, and verified findings

## Status

Early. The data layer works end to end; storage tracking is not built yet.

| | |
|---|---|
| Rulebook fetcher (relay, both encodings) | done |
| Stock normalizer (three endpoint shapes) | done |
| Discord connection + `/travelers`, `/traveler` | done |
| Storage picker, thresholds, tracker message | not started |

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
src/stock/normalize.mjs   the three container shapes -> one
src/commands.mjs          slash commands
src/bot.mjs               entry point
```

Data from community projects: [bitjita](https://bitjita.com) and
[bitcraftsync](https://relay.bitcraftsync.app). Both are public and run by volunteers —
the rulebook is cached rather than refetched partly to keep load off them.
