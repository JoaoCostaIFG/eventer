import {logger} from './log.js';
import type {FluxerApi} from './api.js';
import {parseCommand, resolveWallDate, type Command} from './commands.js';
import type {Config} from './config.js';
import type {EventEntry, EventStore} from './store.js';
import {
	firstOccurrence,
	formatInstant,
	formatWallDate,
	formatWallTime,
	instantToWallDate,
	wallToInstant,
} from './time.js';
import type {
	Channel,
	CreateMessageBody,
	EmbedInput,
	MessageCreateData,
	Snowflake,
} from './types.js';
import {GUILD_TEXT, GUILD_VOICE} from './types.js';

const NOT_FOUND_LOG_INTERVAL_MS = 5 * 60_000;
/** "Within a month" for @eventer list. */
const LIST_WINDOW_DAYS = 31;
const LIST_MAX_LINES = 25;
const EMBED_LIMIT = 4_096;

const COLOR_OK = 0x2e_cc_71;
const COLOR_ERROR = 0xe7_4c_3c;
const COLOR_INFO = 0x58_65_f2;
const COLOR_PARTY = 0xff_ac_33;
const COLOR_CAKE = 0xe8_3e_8c;

function recurrenceLabel(recurrence: string): string {
	switch (recurrence) {
		case 'once':
			return 'one-off';
		case 'weekly':
			return 'every week';
		case 'monthly':
			return 'every month';
		case 'yearly':
			return 'every year';
		default:
			return recurrence;
	}
}

function emojiFor(entry: EventEntry): string {
	return entry.recurrence === 'yearly' ? '🎂' : '🎉';
}

/**
 * Eventer brain: parses mention commands into event store mutations, and
 * posts announcements into each guild's configured events channel.
 */
export class Eventer {
	private readonly channelsByGuild = new Map<Snowflake, Map<Snowflake, Channel>>();
	private readonly notFoundLoggedAt = new Map<Snowflake, number>();
	private botUserId: Snowflake | null = null;

	constructor(
		private readonly config: Config,
		private readonly api: FluxerApi,
		private readonly store: EventStore,
	) {}

	setBotUserId(id: Snowflake): void {
		this.botUserId = id;
	}

	// -- Guild/channel cache --------------------------------------------------

	onGuildCreate(guildId: Snowflake, channels: Channel[] | undefined): void {
		if (channels === undefined) return;
		const map = new Map<Snowflake, Channel>();
		for (const channel of channels) map.set(channel.id, channel);
		this.channelsByGuild.set(guildId, map);
		logger.info(`Cached ${map.size} channels for guild ${guildId}`);
	}

	/**
	 * Drop the channel cache; also forget the guild's events when the bot was
	 * actually removed (`unavailable` marks a temporary outage instead).
	 */
	onGuildDelete(guildId: Snowflake, unavailable: boolean): void {
		this.channelsByGuild.delete(guildId);
		this.notFoundLoggedAt.delete(guildId);
		if (unavailable) return;
		const events = this.store.forGuild(guildId);
		if (events.length === 0) return;
		for (const entry of events) this.store.remove(entry.id);
		logger.info(`Left guild ${guildId}; dropped ${events.length} scheduled events`);
	}

	onChannelUpdate(channel: Channel): void {
		const guildId = channel.guild_id;
		if (guildId === undefined) return;
		this.guildChannels(guildId).set(channel.id, channel);
	}

	onChannelDelete(channel: Channel): void {
		const guildId = channel.guild_id;
		if (guildId === undefined) return;
		this.guildChannels(guildId).delete(channel.id);
	}

	private guildChannels(guildId: Snowflake): Map<Snowflake, Channel> {
		let map = this.channelsByGuild.get(guildId);
		if (map === undefined) {
			map = new Map<Snowflake, Channel>();
			this.channelsByGuild.set(guildId, map);
		}
		return map;
	}

	/** The configured value is either a channel name or a literal channel ID. */
	private matchesEventsChannel(channel: Channel): boolean {
		const wanted = this.config.eventsChannel;
		if (/^\d+$/.test(wanted)) return channel.id === wanted;
		// Text bearing guild channel types only.
		if (channel.type !== GUILD_TEXT && channel.type !== GUILD_VOICE) return false;
		return (channel.name ?? '').toLowerCase() === wanted;
	}

	/** Resolve the events channel, refreshing the guild cache over HTTP once if needed. */
	private async resolveEventsChannel(guildId: Snowflake): Promise<Channel | null> {
		let channel = this.findEventsChannelInCache(guildId);
		if (channel !== null) return channel;

		try {
			const channels = await this.api.listGuildChannels(guildId);
			const map = new Map<Snowflake, Channel>();
			for (const c of channels) map.set(c.id, c);
			this.channelsByGuild.set(guildId, map);
			channel = this.findEventsChannelInCache(guildId);
		} catch (error) {
			logger.warn(`Failed to list channels for guild ${guildId}: ${(error as Error).message}`);
			return null;
		}
		return channel;
	}

	private findEventsChannelInCache(guildId: Snowflake): Channel | null {
		const map = this.channelsByGuild.get(guildId);
		if (map === undefined) return null;
		for (const channel of map.values()) {
			if (this.matchesEventsChannel(channel)) return channel;
		}
		return null;
	}

	private logNotFound(guildId: Snowflake): void {
		const now = Date.now();
		const last = this.notFoundLoggedAt.get(guildId) ?? 0;
		if (now - last < NOT_FOUND_LOG_INTERVAL_MS) return;
		this.notFoundLoggedAt.set(guildId, now);
		logger.warn(
			`No events channel found in guild ${guildId} (looked for "${this.config.eventsChannel}"); ` +
				'events in this guild cannot be announced until one exists',
		);
	}

	// -- Commands -------------------------------------------------------------

	async onMessageCreate(data: MessageCreateData): Promise<void> {
		if (this.botUserId === null) return; // not ready yet
		const guildId = data.guild_id;
		if (guildId === undefined) return; // DMs have no events channel
		const author = data.author;
		if (author === undefined || author.bot === true) return;
		if (author.id === this.botUserId) return;
		// The Gateway also delivers @everyone/@here/role mentions past the
		// ignored_events filter; only direct mentions of this bot are commands.
		const mentions = data.mentions ?? [];
		if (!mentions.some((user) => user.id === this.botUserId)) return;

		const parsed = parseCommand(data.content ?? '', this.botUserId);
		if (parsed === null) return;

		const body =
			parsed.error !== undefined
				? this.errorBody(parsed.error)
				: await this.runCommand(parsed.command!, data, guildId);

		try {
			await this.api.createMessage(data.channel_id, body);
		} catch (error) {
			logger.error(`Failed to reply in channel ${data.channel_id}`, error);
		}
	}

	private async runCommand(
		command: Command,
		data: MessageCreateData,
		guildId: Snowflake,
	): Promise<CreateMessageBody> {
		switch (command.kind) {
			case 'add':
				return this.runAdd(command, data, guildId);
			case 'remove':
				return this.runRemove(command, data, guildId);
			case 'list':
				return this.runList(command, guildId);
			case 'help':
				return this.helpBody();
		}
	}

	private runAdd(
		command: Extract<Command, {kind: 'add'}>,
		data: MessageCreateData,
		guildId: Snowflake,
	): CreateMessageBody {
		const {timeZone} = this.config;
		const now = new Date();
		const today = instantToWallDate(now, timeZone);
		const base = resolveWallDate(command.date, today.year);
		const time = command.time ?? {hour: this.config.defaultEventHour, minute: 0};
		const occurrence =
			command.recurrence === 'once' ? base : firstOccurrence(command.recurrence, base, today);
		const instant = wallToInstant(occurrence, time, timeZone);

		if (command.recurrence === 'once' && instant.getTime() <= now.getTime()) {
			return this.errorBody(
				'That date and time has already passed. One-off events must be in the future.',
			);
		}

		const entry: EventEntry = {
			id: this.store.allocateId(),
			guildId,
			title: command.title,
			creatorId: data.author.id,
			creatorName: data.author.global_name ?? data.author.username,
			recurrence: command.recurrence,
			nextOccurrence: instant.toISOString(),
			localDate: formatWallDate(occurrence),
			localTime: command.time === null ? undefined : formatWallTime(command.time),
			createdAt: now.toISOString(),
		};
		this.store.add(entry);
		logger.info(
			`Added event #${entry.id} "${entry.title}" (${entry.recurrence}) in guild ${entry.guildId}; ` +
				`next occurrence ${entry.nextOccurrence}`,
		);

		const embed: EmbedInput = {
			title: `✅ Added ${entry.title}`,
			color: COLOR_OK,
			fields: [
				{name: 'When', value: formatInstant(instant, timeZone, entry.localTime !== undefined), inline: true},
				{name: 'Repeats', value: recurrenceLabel(entry.recurrence), inline: true},
			],
			footer: {text: `Event #${entry.id} — remove with: @eventer remove ${entry.id}`},
		};
		return {embeds: [embed], allowed_mentions: {parse: []}};
	}

	private runRemove(
		command: Extract<Command, {kind: 'remove'}>,
		data: MessageCreateData,
		guildId: Snowflake,
	): CreateMessageBody {
		const entry = this.store.get(command.id);
		if (entry === undefined || entry.guildId !== guildId) {
			return this.errorBody(`No event #${command.id} here. Find ids with @eventer list.`);
		}
		const isCreator = entry.creatorId === data.author.id;
		const isAdmin = this.config.adminIds.has(data.author.id);
		if (!isCreator && !isAdmin) {
			return this.errorBody('Only the person who added this event (or a bot admin) can remove it.');
		}

		this.store.remove(entry.id);
		logger.info(`Removed event #${entry.id} "${entry.title}" in guild ${entry.guildId}`);
		return {
			embeds: [
				{
					title: `🗑️ Removed ${entry.title}`,
					color: COLOR_OK,
					footer: {text: `Event #${entry.id}`},
				},
			],
			allowed_mentions: {parse: []},
		};
	}

	private runList(
		command: Extract<Command, {kind: 'list'}>,
		guildId: Snowflake,
	): CreateMessageBody {
		const now = Date.now();
		const windowEnd = now + LIST_WINDOW_DAYS * 86_400_000;
		const entries = this.store
			.forGuild(guildId)
			.slice()
			.sort((a, b) => a.nextOccurrence.localeCompare(b.nextOccurrence));
		const scoped =
			command.scope === 'month'
				? entries.filter((entry) => Date.parse(entry.nextOccurrence) <= windowEnd)
				: entries;

		const title =
			command.scope === 'month' ? '📅 Events in the next month' : '📅 All upcoming events';
		if (scoped.length === 0) {
			const hint =
				command.scope === 'month'
					? 'No events in the next month.'
					: 'No upcoming events. Add one with @eventer add!';
			return {embeds: [{title, description: hint, color: COLOR_INFO}], allowed_mentions: {parse: []}};
		}

		// Pagination: LIST_MAX_LINES events per page, page 1 by default.
		const totalPages = Math.max(1, Math.ceil(scoped.length / LIST_MAX_LINES));
		if (command.page > totalPages) {
			return this.errorBody(
				`There ${totalPages === 1 ? 'is only' : 'are only'} ${totalPages} ` +
					`${totalPages === 1 ? 'page' : 'pages'} of events (${scoped.length} total).`,
			);
		}
		const pageEntries = scoped.slice(
			(command.page - 1) * LIST_MAX_LINES,
			command.page * LIST_MAX_LINES,
		);

		const lines = pageEntries.map(
			(entry) =>
				`${emojiFor(entry)} ${this.occurrenceLine(entry)} (#${entry.id})`,
		);
		let description = lines.join('\n');
		if (description.length > EMBED_LIMIT) {
			description = `${description.slice(0, EMBED_LIMIT - 4)}\n[…]`;
		}

		const scopeToken = command.scope === 'all' ? 'all ' : '';
		const footer =
			totalPages > 1
				? `Page ${command.page}/${totalPages} · ${scoped.length} events — ` +
					(command.page < totalPages
						? `@eventer list ${scopeToken}${command.page + 1} for more`
						: 'end of list')
				: `${scoped.length} ${scoped.length === 1 ? 'event' : 'events'}`;
		return {
			embeds: [{title, description, color: COLOR_INFO, footer: {text: footer}}],
			allowed_mentions: {parse: []},
		};
	}

	private occurrenceLine(entry: EventEntry): string {
		const when = formatInstant(
			new Date(entry.nextOccurrence),
			this.config.timeZone,
			entry.localTime !== undefined,
		);
		return `${when} — ${entry.title}`;
	}

	private helpBody(): CreateMessageBody {
		const description = [
			'`@eventer add <date> [HH:MM] <title> [--yearly|--monthly|--weekly]`',
			'`@eventer remove <id>`',
			'`@eventer list [all] [page]`',
			'',
			'Examples:',
			"`@eventer add --yearly 03-15 Maria's birthday`",
			'`@eventer add 2026-12-25 18:00 Christmas dinner`',
			'`@eventer add --weekly 2026-09-25 20:00 Game night`',
			'',
			`Dates are YYYY-MM-DD (or MM-DD with --yearly); times are HH:MM in ${this.config.timeZone}. ` +
				'Events without a time are announced at ' +
				`${this.config.defaultEventHour}:00. Announcements go to #${this.config.eventsChannel}.`,
		].join('\n');
		return {embeds: [{title: '🎂 eventer — commands', description, color: COLOR_INFO}], allowed_mentions: {parse: []}};
	}

	private errorBody(message: string): CreateMessageBody {
		return {
			embeds: [{title: '❌ Error', description: message, color: COLOR_ERROR}],
			allowed_mentions: {parse: []},
		};
	}

	// -- Announcements ----------------------------------------------------------

	/**
	 * Post announcements for the given (due) events, one message each, into
	 * the events channel of the event's guild. Returns the ids that were
	 * announced successfully; failures are retried on the next scheduler tick.
	 */
	async announce(entries: EventEntry[]): Promise<Set<string>> {
		const announced = new Set<string>();
		const byGuild = new Map<Snowflake, EventEntry[]>();
		for (const entry of entries) {
			const group = byGuild.get(entry.guildId) ?? [];
			group.push(entry);
			byGuild.set(entry.guildId, group);
		}

		for (const [guildId, group] of byGuild) {
			const channel = await this.resolveEventsChannel(guildId);
			if (channel === null) {
				this.logNotFound(guildId);
				continue;
			}
			for (const entry of group) {
				try {
					await this.api.createMessage(channel.id, this.announcementBody(entry));
					announced.add(entry.id);
					logger.info(`Announced event #${entry.id} "${entry.title}" in guild ${guildId}`);
				} catch (error) {
					logger.error(`Failed to announce event #${entry.id}; retrying next tick`, error);
				}
			}
		}
		return announced;
	}

	private announcementBody(entry: EventEntry): CreateMessageBody {
		const {timeZone} = this.config;
		const emoji = emojiFor(entry);
		const timed = entry.localTime !== undefined;
		const suffix = timed ? ` — today at ${entry.localTime}!` : ' is today!';
		const content = `${emoji} **${entry.title}**${suffix}`;

		const embed: EmbedInput = {
			title: entry.title,
			color: entry.recurrence === 'yearly' ? COLOR_CAKE : COLOR_PARTY,
			timestamp: entry.nextOccurrence,
			fields: [
				{name: 'Date', value: formatInstant(new Date(entry.nextOccurrence), timeZone, timed), inline: true},
				{name: 'Repeats', value: recurrenceLabel(entry.recurrence), inline: true},
				{name: 'Added by', value: entry.creatorName, inline: true},
			],
			footer: {text: `Event #${entry.id}`},
		};

		if (this.config.announceEveryone) {
			return {content: `@everyone ${content}`, embeds: [embed], allowed_mentions: {parse: ['everyone']}};
		}
		return {content, embeds: [embed], allowed_mentions: {parse: []}};
	}
}
