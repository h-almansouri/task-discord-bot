# Setting the bot up in your Discord server

About ten minutes. You'll create a Discord application, invite it to your server, and run
it locally.

> **Never paste your bot token into a chat, an issue, or a commit — including to me.**
> It is a password for the bot account. If one leaks, regenerate it immediately in the
> Developer Portal; the old one stops working straight away. `.env` is gitignored, and
> `.gitignore` was committed before any token existed, so there is no window where it
> could be committed by accident.

---

## 1. Create the application

1. Go to <https://discord.com/developers/applications> and click **New Application**.
2. Name it whatever you want — this is the name users see. Accept the terms, **Create**.
3. On **General Information**, copy the **Application ID**. That's your
   `DISCORD_CLIENT_ID`.

## 2. Create the bot user and get a token

1. Open the **Bot** tab in the left sidebar.
2. Click **Reset Token**, confirm, then **Copy**. This is your `DISCORD_TOKEN`, and
   Discord will not show it again — if you lose it, reset it and use the new one.
3. Leave all three **Privileged Gateway Intents** switched **off**. This bot uses only
   slash commands and never reads message content, so it needs none of them. If a guide
   tells you to enable Message Content Intent, it is describing a different kind of bot.

## 3. Invite it to your server

1. Open **Installation** in the sidebar (older portals call this **OAuth2 → URL
   Generator**).
2. Under **Guild Install**, set scopes to **`bot`** and **`applications.commands`**.
   Without `applications.commands`, slash commands will not register.
3. Give it these permissions, and no more:

   | Permission | Why |
   |---|---|
   | View Channels | see the channel it posts in |
   | Send Messages | post the tracker message |
   | Embed Links | the tracker is an embed |
   | Read Message History | find its own message to edit in place |

4. Copy the generated URL, open it, pick your server, **Authorize**.

If you'd rather skip the generator, this is the same thing — replace `YOUR_CLIENT_ID`:

```
https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=84992&scope=bot%20applications.commands
```

`84992` is exactly the four permissions above. It deliberately does **not** include
Administrator, and you should not grant it.

## 4. Get your server id

Slash commands registered to one server appear instantly; global ones can take up to an
hour. During testing you want the former.

1. Discord **Settings → Advanced → Developer Mode**, on.
2. Right-click your server in the sidebar → **Copy Server ID**. That's `DISCORD_GUILD_ID`.

---

## 5. Run it

> **On Windows PowerShell**, `npm install` may fail with *"npm.ps1 cannot be loaded
> because running scripts is disabled on this system"*. That is PowerShell's execution
> policy blocking npm's `.ps1` wrapper — nothing to do with this project. Three ways
> past it, in order of least disruption:
>
> 1. **Call node directly** and skip npm — every command below has a plain-node form.
> 2. **Use `npm.cmd`** instead of `npm`, which avoids the `.ps1` wrapper entirely.
> 3. **Allow local scripts** for your user only:
>    `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`. This is a security setting —
>    `RemoteSigned` permits local scripts while still requiring downloaded ones to be
>    signed. Your call whether to change it.

```bash
npm install
```

Copy `.env.example` to `.env` and fill in the three values:

```
DISCORD_TOKEN=your-token-here
DISCORD_CLIENT_ID=your-application-id
DISCORD_GUILD_ID=your-server-id
```

Generate the rulebook — the list of every task each traveler can give. This reads a
community relay once and writes `data/rulebook.json`:

```bash
npm run rulebook
```

Register the slash commands with Discord:

```bash
npm run commands
```

Start the bot:

```bash
npm start
```

Each of those has a plain-node equivalent, useful if npm is blocked:

| npm | node |
|---|---|
| `npm run rulebook` | `node scripts/fetch-rulebook.mjs` |
| `npm run commands` | `node scripts/register-commands.mjs` |
| `npm start` | `node src/bot.mjs` |
| `npm test` | `node --test` |

You should see:

```
rulebook loaded: 321 tasks, 6 travelers (from bitjita, …)
logged in as YourBot#1234
serving 1 guild(s): Your Server
```

---

## 6. Using it

**The three-step setup**, in order:

```
/storage add name:Velcruza      pick which containers hold traveler supplies
/traveler add name:Alesi tier_min:1 tier_max:5    who to keep stocked
/setup channel channel:#supplies                  where the tracker lives
```

After `/setup channel` the tracker posts immediately and then updates itself every
20 seconds, editing in place rather than posting new messages. It only edits when the
numbers actually change, so a quiet claim costs nothing.

**Each traveler gets its own message.** They all share the default channel unless you give
one its own:

```
/setup channel channel:#alesi-supply traveler:Alesi
```

That way people can follow the travelers they care about and mute the rest.

| Command | What it does |
|---|---|
| `/ping` | confirms the bot is connected, shows heartbeat latency |
| `/traveler add name:… tier_min:… tier_max:…` | start tracking a traveler |
| `/traveler update name:… tier_min:… tier_max:…` | change its tiers, keeping everything else |
| `/traveler list` / `/traveler remove` | manage tracked travelers |
| `/traveler ignore traveler:… family:…` | stop watching one material family entirely |
| `/traveler unignore traveler:… family:…` | watch it again |
| `/storage add name:…` | pick which containers count as traveler supply |
| `/storage list` / `/storage remove number:1` | manage tracked storage |
| `/config turnins count:5 [traveler:…]` | how many turn-ins to keep stocked |
| `/config threshold material:… amount:…` | absolute target for one material |
| `/config variable amount:… [traveler:…]` | one target for all varying-quantity materials |
| `/config band tier_min:… tier_max:… turnins:… [traveler:…]` | turn-ins for a tier range |
| `/config bands-clear [traveler:…]` | remove tier bands |
| `/config reminder role:… [hours:…] [channel:…]` | ping that role before the weekly task reroll |
| `/config reminder-off` | stop the reroll ping |
| `/config show` | current settings |
| `/setup channel channel:#… [traveler:…]` | default channel, or one traveler's own |
| `/refresh` | redraw now instead of waiting |

`/traveler name:Alesi` should return five families — Plant Fiber, Grain, Vegetable,
Baitfish, Healing Potion — each spanning T1–T10. That is the grouping described in
DESIGN.md §8, running on real game data.

`/storage add name:Velcruza` fetches every container that character can reach — around
50, across personal slots, house chests, wagons and claim banks — and lets you choose.
Pick a group, tick the containers, then **Save**. Selections carry across groups and
pages, so you can take a few house chests and a claim bank in one go. Nothing is tracked
until you save, and re-running `/storage add` on the same source shows your current
picks ticked so you can edit rather than start over.

Only the person who ran the command sees the picker, and it expires after 14 minutes
(Discord invalidates the interaction after 15).

**Not interested in a whole material family?** `/traveler ignore traveler:Rumbagh
family:Experimental Compounds` drops all ten of its tiers at once, rather than setting
each to zero. Only that traveler is affected, and `/traveler list` shows what's ignored.
To hide a single tier instead, give it a threshold of zero:
`/config threshold material:Flawless Brick amount:0`.

Adding **Svim** or **Ramparte** will prompt you for extra numbers. Those two ask for some
materials at several different quantities — Salt anywhere from 10 to 55 — so "5 turn-ins"
has no single meaning and the bot asks for a plain stock target instead. Anything you
skip stays untracked and shows up in `/traveler list`; nothing is guessed. The other four
travelers add in one step.

To settle all of them at once instead of one by one:

```
/config variable amount:25
```

That covers every varying-quantity material — Ramparte's seven combat drops and Svim's
Salt — and clears the prompts. Narrow it per traveler with
`/config variable amount:5 traveler:Ramparte`, or override a single material with
`/config threshold`, which always wins.

**Want a heads-up before tasks reroll?** Travelers swap their task lists once a week, and
the bot can ping a role ahead of it:

```
/config reminder role:@task-reminders hours:24
```

The ping lands in the tracker channel unless you pass `channel:`, fires once per
rotation (a restart won't re-ping), and reads the in-game reroll clock a few times a
day — so the moment it names is the real one, not a guess. One catch: **the role must be
mentionable** (Server Settings → Roles → "Allow anyone to @mention this role"), or the
bot needs the *Mention @everyone, @here and All Roles* permission — otherwise the message
posts but notifies nobody. The command warns you if that's the case.

---

## When something doesn't work

| Symptom | Cause |
|---|---|
| Commands don't appear | `applications.commands` scope was missing at invite time. Re-invite with the URL above; you do not need to kick the bot first. |
| `Missing Access` from `npm run commands` | `DISCORD_GUILD_ID` is a server the bot isn't in, or was invited without `applications.commands`. |
| `Unauthorized` / 401 | `DISCORD_TOKEN` is wrong or was reset. Copy it again from the Bot tab. |
| `No rulebook at …` | run `npm run rulebook` first. |
| `all relays failed` | both community relays were unreachable. They do have brief outages — wait a few minutes and retry. Nothing is wrong with your setup. |
| Commands appear but nothing happens | the bot process isn't running. `npm start` must stay running; closing the terminal stops it. |

Run `npm test` any time to check the data-handling layer without touching Discord.

---

## Hosting it on Render

The bot needs to run continuously. Two things about Render decide the shape of this:

- **It must be a Background Worker, not a Web Service.** The bot holds an *outbound*
  connection to Discord and never receives inbound HTTP. A free web service spins down
  after 15 minutes without inbound traffic — and since nothing ever calls it, it would
  stay down.
- **Background workers have no free plan**, and neither do persistent disks. Expect about
  **$7/month** for the worker plus a few cents for a 1 GB disk.

The disk matters more than it sounds. Everything outside it is wiped on **every deploy and
restart**, so without one your per-guild settings — channels, travelers, storages,
thresholds — reset each time you push.

### Steps

1. **Push your code to GitHub** (already done if you're reading this from the repo).
2. On Render, **New → Blueprint**, point it at the repository. It picks up
   [`render.yaml`](render.yaml), which already declares the worker, the disk at `/data`,
   and `CONFIG_DIR=/data/config`.
3. Render will prompt for the three values marked `sync: false`. Enter
   `DISCORD_TOKEN`, `DISCORD_CLIENT_ID` and `DISCORD_GUILD_ID` **in the dashboard** —
   never in `render.yaml`, which is committed.
4. Deploy. The logs should show:
   ```
   rulebook loaded: 321 tasks, 6 travelers …
   logged in as YourBot#1234
   tracker polling every 20s
   ```
5. **Register the slash commands once, from your own machine:**
   ```bash
   node scripts/register-commands.mjs
   ```
   This only talks to Discord's API, so it doesn't need to run on the server. Re-run it
   whenever a command's shape changes.

### Worth knowing

- **Run the bot in one place at a time.** Two instances on the same token both answer every
  interaction and both edit the tracker, which looks like the bot fighting itself. Stop
  your local `node src/bot.mjs` once Render is live.
- **The rulebook ships with the repo**, so the server never calls a relay at startup. After
  a game patch, run `npm run rulebook` locally, commit the result, and let it deploy.
- **A disk means no zero-downtime deploys** — Render stops the old instance before starting
  the new one. For this bot a few seconds' gap is invisible; the tracker just redraws.
- **Prefer global commands in production.** Leave `DISCORD_GUILD_ID` blank and the commands
  work in every server the bot joins, at the cost of up to an hour to propagate.

### If you'd rather not pay

There's no free configuration of Render that works for this: the free tier lacks both the
worker type and the persistent disk. The realistic alternatives are another host with a
free always-on tier, a small VPS, or running it on a machine you leave on. `CONFIG_DIR`
makes any of those a one-line change.
