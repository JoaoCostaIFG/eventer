# eventer

An events bot for [Fluxer](https://fluxer.app): members mention the bot to
schedule events — birthdays, game nights, holidays — and the bot announces
them in an **events** channel on their date (and time). Built for self-hosted
instances and friends servers.

```
@eventer add --yearly 03-15 Maria's birthday
@eventer add 2026-12-25 18:00 Christmas dinner
@eventer add --weekly 2026-09-25 20:00 Game night

@eventer list
📅 Events in the next month
🎂 Sun, 15 Mar 2026 — Maria's birthday (#1)
🎉 Fri, 25 Sep 2026 at 20:00 — Game night (#2)
```

On the day (at the time, or `DEFAULT_EVENT_HOUR` for all-day events):

```
🎂 **Maria's birthday** is today!
┌──────────────────────────────────────┐
│ Maria's birthday                     │
│ Date: Sun, 15 Mar 2026               │
│ Repeats: every year   Added by: Aria │
│                         Event #1     │
└──────────────────────────────────────┘
```

## What it does

- Connects to your instance's Gateway as a bot and receives every message
  that **mentions it** — Fluxer delivers direct mentions even when
  `MESSAGE_CREATE` is suppressed via `ignored_events`, so the bot sees
  commands and nothing else.
- `@eventer add <date> [HH:MM] <title> [--yearly|--monthly|--weekly]`
  schedules an event. Dates are `YYYY-MM-DD`, or `MM-DD` with `--yearly`
  (birthday style). Recurring events repeat forever: yearly (Feb 29 clamps
  to Feb 28), monthly (Jan 31 clamps to the month's last day), and weekly.
- `@eventer remove <id>` removes one of your events; the user ids in
  `EVENT_ADMINS` can remove anyone's.
- `@eventer list` shows the next month of events; `@eventer list all` shows
  everything upcoming. Long lists are paginated at 25 events per page —
  `@eventer list all 2` shows the second page, and the footer of each page
  tells you how many pages there are. `@eventer help` prints usage.
- A scheduler ticks every `TICK_SECONDS` and posts each due event into the
  channel named `events` (case-insensitive; or set an exact channel ID).
  All-day events announce at `DEFAULT_EVENT_HOUR` in `TIMEZONE`.
- Announcements that fail (e.g. missing events channel) are retried on the
  next tick. Events that came due while the bot was offline still announce,
  as long as they are within `GRACE_HOURS` (default 24); anything older is
  skipped and the series moves on.
- Events live in `data/events.json` (atomic writes), so restarts never lose
  or double-fire them. When the bot is removed from a guild, that guild's
  events are dropped.

## One-time setup on your instance

### 1. Create a bot application

With a **user session token** (log in via the web app and grab the token from
your authenticated client, or use `POST /v1/auth/login`):

```bash
curl -X POST https://chat.example.com/v1/oauth2/applications \
  -H "Authorization: flx_YOUR_USER_SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "eventer"}'
```

The response contains `bot.token` — the **bot token** (`<application_id>.<secret>`).
It is shown **once**; if you lose it, rotate with
`POST /v1/oauth2/applications/{id}/bot/reset-token`.

### 2. Install the bot into your guild

Open this URL in a browser where you are logged in to Fluxer:

```
https://chat.example.com/v1/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot&permissions=84992
```

`permissions=84992` is `VIEW_CHANNEL | SEND_MESSAGES | EMBED_LINKS | READ_MESSAGE_HISTORY`.
`READ_MESSAGE_HISTORY` is required for the Gateway to deliver message events at
all in guilds without a message-history cutoff — without it, commands never
arrive. If you set `ANNOUNCE_MENTION=everyone`, use `permissions=216064`
instead, which adds `MENTION_EVERYONE` for the announcement ping.
Select your guild and confirm. Make sure the bot can see the events channel
(no permission overwrites blocking it).

### 3. Configure

```bash
cp .env.example .env
# edit .env: set INSTANCE_URL and BOT_TOKEN (and TIMEZONE!)
```

All settings live in `.env` and are read at startup. See `.env.example` for
the full reference. The bot resolves the events channel **per guild** by
name, so it works in every guild it is installed in.

## Running

The image is published to GitHub Container Registry for **linux/amd64 and
linux/arm64**: [`ghcr.io/joaocostaifg/eventer`](https://github.com/JoaoCostaIFG/pkgs/container/eventer).
Tags: `latest`, `main`, `1.2.3`/`1.2`/`1` for `v*` releases, and `sha-<commit>`.

### Docker (recommended)

```bash
docker compose pull && docker compose up -d
docker compose logs -f
```

The event store lives in the `eventer-data` volume. The container healthcheck
watches a heartbeat file the bot touches whenever the gateway connection is
alive, so a wedged connection ends in a container restart
(`restart: unless-stopped`).

To build locally instead of pulling (e.g. for development):

```bash
docker compose up -d --build
```

Updating:

```bash
git pull && docker compose pull && docker compose up -d
```

## Releases and update notifications

`docker-compose.yml` pins an exact image version; Renovate opens PRs to bump
it whenever a new `v*` tag is pushed. Cutting a release looks like:

```bash
git tag v0.1.1 && git push origin v0.1.1
```

That single push produces, automatically:

- image tags `0.1.1`, `0.1`, and `1` on GHCR (multi-arch), and
- a GitHub Release with generated release notes.

[Renovate](https://docs.renovatebot.app/) then picks up the new version tag
from the compose file and opens an update PR (see `renovate.json`). Note that
Renovate can only see the package once its GHCR visibility is **public**
(private packages need `hostRules` credentials in your Renovate config).

Version tags are plain semver derived from the git tag (`v1.2.3` → `1.2.3`,
`1.2`, `1`); `latest` and `main` always track the default branch.

### Same-server deployments

If Fluxer runs in Docker on the same host, keep routing through the public
origin (`INSTANCE_URL`). The bot's traffic hairpins through the edge proxy,
which is fine for a friends-server bot.

**Do not point `API_URL` at the `api` container directly.** Self-hosted Fluxer
defaults to `FLUXER_TRUST_CLIENT_IP_HEADER=true`, which makes the API reject
every request that lacks a valid `x-forwarded-for` header — that is, anything
that did not come through the edge proxy — with `403 Forbidden [FORBIDDEN]`.
The gateway has no such check, which makes this failure confusing: the bot
connects, receives mention commands, and then every HTTP call fails.

Container-to-container routing only works if you set
`FLUXER_TRUST_CLIENT_IP_HEADER=false` for the Fluxer stack — weigh that
carefully, since per-IP rate limiting and logging degrade without it.

### Without Docker

```bash
npm install
npm run build
npm start          # or: npm run dev for hot-reload during development
```

## Development

- `npm run typecheck` — type-check without emitting
- `npm run smoke` — end-to-end test against a mock Fluxer instance (discovery,
  gateway identify, mention commands: add/list/remove/permissions/errors, the
  scheduler announcing a due event, recurrence advance, disconnect/resume).
  Runs the built output, so `npm run build` first.

## Behavior notes

- **Mention delivery**: the bot suppresses `MESSAGE_CREATE` in `ignored_events`
  and relies on Fluxer's mention override — only messages that mention the bot
  directly (plus @everyone/@here strays, which are discarded) ever arrive.
  Commands must therefore *start* with the mention.
- **Time zones**: dates and times are interpreted in `TIMEZONE` (default UTC);
  DST transitions are handled via the runtime's IANA database. All-day events
  fire at `DEFAULT_EVENT_HOUR` (default 9:00) in that zone.
- **Recurrence**: adding a recurring event whose date already passed schedules
  the *next* occurrence — except that adding one on its own day still fires
  today, even if the hour has passed (late, but on the right day).
- **One-off events** must be in the future when created.
- **Persistence**: `data/events.json` holds the schedule. Deleting the file
  resets everything; the bot rebuilds it from new commands.
- **Rate limits**: the HTTP client honors `Retry-After` on 429s; the gateway
  client heartbeats on the advertised interval, resumes sessions within the
  60s retention window, and reconnects with backoff.

## License

MIT
