// Smoke test: runs the built bot against a mock Fluxer instance and asserts
// the full chain: discovery -> gateway IDENTIFY -> mention commands (add,
// list, remove, errors) -> scheduler announcement -> recurrence advance.
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdirSync, rmSync} from 'node:fs';
import {WebSocketServer} from 'ws';

const PORT = 8931;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = '/tmp/eventer-smoke-data';

const GUILD = '100';
const CHANNEL_EVENTS = '200'; // #Events (mixed case on purpose)
const CHANNEL_GENERAL = '300';
const BOT_ID = '9999';

const pad = (n) => String(n).padStart(2, '0');

let failures = 0;
const check = (name, condition, extra) => {
	if (condition) {
		console.log(`  ok: ${name}`);
	} else {
		failures++;
		console.error(`  FAIL: ${name}`, extra ?? '');
	}
};

const state = {
	/** Every bot-created message: {channel, body}. */
	posts: [],
};

// -- Expected values (TIMEZONE=UTC in the bot under test) ---------------------

const now = new Date();
const year = now.getUTCFullYear();

// "--yearly 03-15": first occurrence on or after today's calendar date.
const mar15ThisYear = Date.UTC(year, 2, 15);
const startOfToday = Date.UTC(year, now.getUTCMonth(), now.getUTCDate());
const mariaYear = mar15ThisYear >= startOfToday ? year : year + 1;
const mariaWeekday = new Date(Date.UTC(mariaYear, 2, 15)).toUTCString().slice(0, 3);
const mariaWhen = `${mariaWeekday}, 15 Mar ${mariaYear}`;
const mariaOccurrence = new Date(Date.UTC(mariaYear, 2, 15, 9, 0, 0)).toISOString();

// A one-off event ten days out lands inside the 31-day "list" window.
const plusTen = new Date(Date.now() + 10 * 86_400_000);
const plusTenDate = plusTen.toISOString().slice(0, 10);

// The seeded due event advances one year, clamping Feb 29 -> Feb 28.
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
let nextYear = year + 1;
let nextMonth = now.getUTCMonth();
let nextDay = now.getUTCDate();
if (nextMonth === 1 && nextDay === 29 && !isLeap(nextYear)) nextDay = 28;
const seedNext = new Date(Date.UTC(nextYear, nextMonth, nextDay, 9, 0, 0)).toISOString();
const seedLocalDate = `${nextYear}-${pad(nextMonth + 1)}-${pad(nextDay)}`;

const seedOccurrence = new Date(Date.now() - 60_000).toISOString();

// 25 fillers more than a year out push "list all" past one 25-line page,
// exercising pagination without entering the 31-day "list" window.
const fillers = Array.from({length: 25}, (_, i) => {
	const when = new Date(Date.now() + (400 + i) * 86_400_000);
	return {
		id: `f${pad(i + 1)}`,
		guildId: GUILD,
		title: `Filler ${pad(i + 1)}`,
		creatorId: '42',
		creatorName: 'Aria',
		recurrence: 'yearly',
		nextOccurrence: when.toISOString(),
		localDate: when.toISOString().slice(0, 10),
		createdAt: new Date().toISOString(),
	};
});

// -- Seed the store before the bot starts -------------------------------------

rmSync(DATA_DIR, {recursive: true, force: true});
mkdirSync(DATA_DIR, {recursive: true});
const {writeFile} = await import('node:fs/promises');
await writeFile(
	`${DATA_DIR}/events.json`,
	JSON.stringify({
		nextIdNum: 1,
		events: [
			{
				id: 'seed',
				guildId: GUILD,
				title: 'Seeded birthday',
				creatorId: '42',
				creatorName: 'Aria',
				recurrence: 'yearly',
				nextOccurrence: seedOccurrence, // due a minute ago: within grace
				localDate: now.toISOString().slice(0, 10),
				createdAt: new Date().toISOString(),
			},
			...fillers,
		],
	}),
	'utf8',
);

// -- Mock HTTP API --------------------------------------------------------------

const server = createServer((req, res) => {
	const send = (status, body) => {
		res.writeHead(status, {'Content-Type': 'application/json'});
		res.end(JSON.stringify(body));
	};

	if (req.url === '/.well-known/fluxer') {
		return send(200, {
			endpoints: {
				api_public: BASE,
				gateway: `ws://127.0.0.1:${PORT}/gateway`,
				media: `${BASE}/media`,
				static_cdn: BASE,
			},
		});
	}

	const auth = req.headers.authorization ?? '';
	if (!auth.startsWith('Bot ')) {
		return send(401, {code: 'INVALID_AUTH_TOKEN', message: 'no bot prefix'});
	}

	if (req.method === 'GET' && req.url === `/v1/guilds/${GUILD}/channels`) {
		return send(200, [
			{id: CHANNEL_EVENTS, type: 0, guild_id: GUILD, name: 'Events'},
			{id: CHANNEL_GENERAL, type: 0, guild_id: GUILD, name: 'general'},
		]);
	}

	if (req.method === 'POST' && /^\/v1\/channels\/\d+\/messages$/.test(req.url)) {
		let raw = '';
		req.on('data', (chunk) => (raw += chunk));
		req.on('end', () => {
			state.posts.push({channel: req.url.split('/')[3], body: JSON.parse(raw)});
			send(200, {id: `post${state.posts.length}`, channel_id: req.url.split('/')[3], content: ''});
		});
		return;
	}

	send(404, {code: 'UNKNOWN_ROUTE', message: req.url});
});

// -- Mock gateway ----------------------------------------------------------------

const wss = new WebSocketServer({server, path: '/gateway'});
let identifyPayload = null;
let resumePayload = null;
let connections = 0;
let heartbeatAfterResume = false;
let seq = 0;

const dispatch = (ws, t, d) => ws.send(JSON.stringify({op: 0, t, s: ++seq, d}));

const aria = {id: '42', username: 'aria', discriminator: '0042', global_name: 'Aria'};
const bob = {id: '43', username: 'bob', discriminator: '0043', global_name: 'Bob'};
const botMention = [{id: BOT_ID, username: 'eventer', discriminator: '0001'}];

const message = (author, content, mentions, id) => ({
	id,
	channel_id: CHANNEL_GENERAL,
	author,
	type: 0,
	content,
	timestamp: new Date().toISOString(),
	mentions,
	mention_everyone: false,
	attachments: [],
	guild_id: GUILD,
	channel_type: 0,
});

wss.on('connection', (ws) => {
	connections++;
	ws.send(JSON.stringify({op: 10, d: {heartbeat_interval: 2000}}));

	ws.on('message', (raw) => {
		const payload = JSON.parse(raw.toString());
		if (payload.op === 2) {
			identifyPayload = payload.d;
			dispatch(ws, 'READY', {
				session_id: 'sess-1',
				user: {id: BOT_ID, username: 'eventer', discriminator: '0001', flags: 0},
				guilds: [{id: GUILD, unavailable: true}],
			});
			dispatch(ws, 'GUILD_CREATE', {
				id: GUILD,
				channels: [
					{id: CHANNEL_EVENTS, type: 0, guild_id: GUILD, name: 'Events'},
					{id: CHANNEL_GENERAL, type: 0, guild_id: GUILD, name: 'general'},
				],
			});

			setTimeout(() => {
				dispatch(ws, 'MESSAGE_CREATE', message(aria, `<@${BOT_ID}> add --yearly 03-15 Maria's birthday`, botMention, 'm1'));
				dispatch(ws, 'MESSAGE_CREATE', message(aria, `<@${BOT_ID}> add ${plusTenDate} 18:00 Christmas dinner`, botMention, 'm2'));
				dispatch(ws, 'MESSAGE_CREATE', message(aria, `<@${BOT_ID}> list`, botMention, 'm3'));
				dispatch(ws, 'MESSAGE_CREATE', message(aria, `<@${BOT_ID}> list all`, botMention, 'm4'));
				dispatch(ws, 'MESSAGE_CREATE', message(bob, `<@${BOT_ID}> remove 1`, botMention, 'm5'));
				dispatch(ws, 'MESSAGE_CREATE', message(aria, `<@${BOT_ID}> remove 2`, botMention, 'm6'));
				dispatch(ws, 'MESSAGE_CREATE', message(aria, `<@${BOT_ID}> list all`, botMention, 'm7'));
				// Mentions someone else entirely: must be ignored.
				dispatch(ws, 'MESSAGE_CREATE', message(aria, '<@7> hello there', [{id: '7', username: 'zoe', discriminator: '0007'}], 'm8'));
				// The bot's own message echoing a mention: must be ignored.
				dispatch(ws, 'MESSAGE_CREATE', message({...aria, id: BOT_ID, bot: true}, `<@${BOT_ID}> add 2020-01-01 self`, botMention, 'm9'));
				dispatch(ws, 'MESSAGE_CREATE', message(aria, `<@${BOT_ID}> add 2026-02-30 Party`, botMention, 'm10'));
				dispatch(ws, 'MESSAGE_CREATE', message(aria, `<@${BOT_ID}> frobnicate`, botMention, 'm11'));
				dispatch(ws, 'MESSAGE_CREATE', message(aria, `<@${BOT_ID}>`, botMention, 'm12'));
				// Pagination: 27 events remain (maria + seed + 25 fillers).
				dispatch(ws, 'MESSAGE_CREATE', message(aria, `<@${BOT_ID}> list all 2`, botMention, 'm13'));
				dispatch(ws, 'MESSAGE_CREATE', message(aria, `<@${BOT_ID}> list all 99`, botMention, 'm14'));
				dispatch(ws, 'MESSAGE_CREATE', message(aria, `<@${BOT_ID}> list all xyz`, botMention, 'm15'));
			}, 300);
		}
		if (payload.op === 1) {
			ws.send(JSON.stringify({op: 11}));
			if (resumePayload !== null) heartbeatAfterResume = true;
		}
		if (payload.op === 6) {
			resumePayload = payload.d;
			heartbeatAfterResume = false;
			ws.send(JSON.stringify({op: 0, t: 'RESUMED', s: seq}));
		}
	});
});

// -- Run the bot -------------------------------------------------------------------

server.listen(PORT, '127.0.0.1', () => {
	console.log(`mock instance on ${BASE}`);
	const child = spawn('node', ['dist/index.js'], {
		cwd: new URL('..', import.meta.url).pathname,
		env: {
			...process.env,
			INSTANCE_URL: BASE,
			BOT_TOKEN: '1234567890.secretsecret',
			EVENTS_CHANNEL_NAME: 'events', // case-insensitive vs 'Events'
			TIMEZONE: 'UTC',
			DEFAULT_EVENT_HOUR: '9',
			TICK_SECONDS: '1',
			GRACE_HOURS: '24',
			DATA_DIR: DATA_DIR,
			LOG_LEVEL: 'debug',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	child.stdout.on('data', (d) => process.stdout.write(`[bot] ${d}`));
	child.stderr.on('data', (d) => process.stderr.write(`[bot] ${d}`));

	setTimeout(async () => {
		console.log('\n--- assertions ---');
		check('identified with raw token + properties + ignored_events',
			identifyPayload?.token === '1234567890.secretsecret' &&
			identifyPayload?.properties?.browser === 'eventer' &&
			Array.isArray(identifyPayload?.ignored_events) &&
			// MESSAGE_CREATE stays ignored on purpose: the mention override
			// delivers commands anyway (see gateway.ts).
			identifyPayload.ignored_events.includes('MESSAGE_CREATE') &&
			identifyPayload.ignored_events.includes('TYPING_START') &&
			!identifyPayload.ignored_events.includes('GUILD_CREATE'),
			identifyPayload);

		const replies = state.posts.filter((p) => p.channel === CHANNEL_GENERAL);
		const announcements = state.posts.filter((p) => p.channel === CHANNEL_EVENTS);

		check('exactly one announcement posted', announcements.length === 1, announcements.length);
		const announcement = announcements[0]?.body;
		if (announcement) {
			check('announcement content',
				announcement.content === '🎂 **Seeded birthday** is today!', announcement.content);
			const embed = announcement.embeds?.[0];
			check('announcement embed details',
				embed?.fields?.[2]?.name === 'Added by' && embed.fields[2].value === 'Aria' &&
				embed?.footer?.text === 'Event #seed' &&
				embed?.timestamp === seedOccurrence,
				embed);
			check('announcement suppresses mentions',
				JSON.stringify(announcement.allowed_mentions) === '{"parse":[]}', announcement.allowed_mentions);
		}

		check('thirteen command replies, strays ignored', replies.length === 13, replies.length);

		// Replies are matched by content, not order: the bot's HTTP client may
		// complete requests out of issue order.
		const embed = (reply) => reply?.body?.embeds?.[0];
		const byTitle = (title) => replies.find((r) => embed(r)?.title === title);
		const withDescription = (needle) =>
			replies.find((r) => typeof embed(r)?.description === 'string' && embed(r).description.includes(needle));

		const addYearly = embed(byTitle(`✅ Added Maria's birthday`));
		check('add --yearly confirmation',
			addYearly?.fields?.[0]?.value === mariaWhen &&
			addYearly?.fields?.[1]?.value === 'every year' &&
			addYearly?.footer?.text.startsWith('Event #1 —'),
			addYearly);

		const addOnce = embed(byTitle('✅ Added Christmas dinner'));
		check('add one-off with time confirmation',
			addOnce?.fields?.[0]?.value.includes(' at 18:00') &&
			addOnce?.fields?.[1]?.value === 'one-off',
			addOnce);

		const listMonth = embed(byTitle('📅 Events in the next month'));
		check('list window shows only the near event',
			listMonth?.description?.includes('Christmas dinner (#2)') &&
			!listMonth?.description?.includes("Maria's birthday"),
			listMonth);

		const listAlls = replies.filter((r) => embed(r)?.title === '📅 All upcoming events');
		const listAllBefore = listAlls.find((r) => embed(r)?.description?.includes('Christmas dinner'));
		const listAllAfter = listAlls.find((r) =>
			embed(r)?.description?.includes("Maria's birthday") &&
			!embed(r)?.description?.includes('Christmas dinner'));
		check('list all before/after the remove',
			listAlls.length === 3 &&
			listAllBefore?.body !== undefined &&
			embed(listAllBefore)?.description?.includes("Maria's birthday (#1)") &&
			listAllAfter !== undefined &&
			embed(listAllAfter)?.description?.includes("Maria's birthday"),
			listAlls.map((r) => embed(r)?.description));

		// 28 events at m4 (seed + maria + christmas + 25 fillers) -> 2 pages.
		check('multi-page list footer advertises the next page',
			embed(listAllBefore)?.footer?.text === 'Page 1/2 · 28 events — @eventer list all 2 for more',
			embed(listAllBefore)?.footer?.text);

		// 27 events at m13 (christmas removed) -> page 2 holds the last two.
		const pageTwo = listAlls.find((r) => embed(r)?.footer?.text?.startsWith('Page 2/'));
		check('list all 2 shows the overflow page',
			embed(pageTwo)?.description?.includes('Filler 25') &&
			!embed(pageTwo)?.description?.includes("Maria's birthday") &&
			embed(pageTwo)?.footer?.text === 'Page 2/2 · 27 events — end of list',
			pageTwo && embed(pageTwo));

		check('out-of-range page reports the page count',
			withDescription('There are only 2 pages of events (27 total).') !== undefined);

		check('non-numeric page rejected',
			withDescription('Usage: @eventer list [all] [page]') !== undefined);

		check('remove by non-creator denied',
			withDescription('Only the person who added') !== undefined,
			replies.map((r) => embed(r)?.description));

		check('remove by creator',
			byTitle('🗑️ Removed Christmas dinner') !== undefined);

		check('invalid calendar date rejected',
			withDescription('not a valid calendar date') !== undefined);

		check('unknown command gets help hint',
			withDescription('Unknown command "frobnicate"') !== undefined);

		check('bare mention shows help',
			byTitle('🎂 eventer — commands') !== undefined);

		// -- Phase 2: forced disconnect -> reconnect -> RESUME -----------------
		console.log('\n--- resume test: dropping connection ---');
		for (const client of wss.clients) client.close(4000, 'Session drain requested; reconnect to continue');
		await new Promise((r) => setTimeout(r, 3500));

		check('reconnected once after the drop', connections === 2, connections);
		check('sent RESUME with the retained session and last sequence',
			resumePayload?.token === '1234567890.secretsecret' &&
			resumePayload?.session_id === 'sess-1' &&
			typeof resumePayload?.seq === 'number' && resumePayload.seq >= 3,
			resumePayload);
		check('heartbeats continue after resume', heartbeatAfterResume);

		const {readFile} = await import('node:fs/promises');
		const store = JSON.parse(await readFile(`${DATA_DIR}/events.json`, 'utf8'));
		const ids = store.events?.map((e) => e.id) ?? [];
		check('store kept maria, dropped removed + completed entries',
			ids.includes('1') && !ids.includes('2'),
			ids);
		check('maria fires at 09:00 UTC on the next Mar 15',
			store.events?.find((e) => e.id === '1')?.nextOccurrence === mariaOccurrence,
			store.events?.find((e) => e.id === '1'));
		check('seeded yearly event advanced one year',
			store.events?.find((e) => e.id === 'seed')?.nextOccurrence === seedNext &&
			store.events?.find((e) => e.id === 'seed')?.localDate === seedLocalDate,
			store.events?.find((e) => e.id === 'seed'));

		child.kill('SIGTERM');
		await new Promise((r) => setTimeout(r, 500));
		wss.close();
		server.close();
		console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILURES`);
		process.exit(failures === 0 ? 0 : 1);
	}, 4000);
});
