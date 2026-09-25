import {logger} from './log.js';
import {isValidTimeZone} from './time.js';
import type {Snowflake} from './types.js';

export interface Config {
	/** Public origin of the instance, e.g. https://chat.example.com */
	instanceUrl: string;
	botToken: string;
	/** Channel name (case-insensitive) or channel ID that receives event announcements. */
	eventsChannel: string;
	/** IANA time zone dates and times are interpreted in. */
	timeZone: string;
	/** Hour (0-23, in `timeZone`) at which all-day events are announced. */
	defaultEventHour: number;
	/** How often due events are checked, in seconds. */
	tickSeconds: number;
	/** How long after its scheduled time an event still announces (downtime catch-up). */
	graceHours: number;
	/** Prefix announcements with @everyone (with the matching allowed-mention). */
	announceEveryone: boolean;
	/** User ids allowed to remove any event, not just their own. */
	adminIds: Set<Snowflake>;
	/** Base URL for links (the URL humans open). */
	webAppBaseUrl: string;
	/** Optional direct API base override (skips discovery when paired with gatewayUrl). */
	apiUrl?: string;
	/** Optional direct Gateway WebSocket URL override. */
	gatewayUrl?: string;
	/** Directory for the persistent event store. */
	dataDir: string;
}

function env(name: string): string | undefined {
	const value = process.env[name];
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	return trimmed === '' ? undefined : trimmed;
}

/** Normalize an HTTP(S) origin (optionally with a path prefix), dropping any trailing slash. */
function parseHttpUrl(name: string, value: string): string {
	try {
		const url = new URL(value);
		if (url.protocol !== 'https:' && url.protocol !== 'http:') {
			throw new Error(`unsupported protocol ${url.protocol}`);
		}
		return url.origin + (url.pathname.replace(/\/+$/, '') || '');
	} catch (error) {
		throw new Error(`${name} is not a valid HTTP(S) URL: ${value} (${(error as Error).message})`);
	}
}

/** Validate a ws(s):// URL, keeping scheme, host, port, and path. */
function parseWsUrl(name: string, value: string): string {
	try {
		const url = new URL(value);
		if (url.protocol !== 'wss:' && url.protocol !== 'ws:') {
			throw new Error(`unsupported protocol ${url.protocol}`);
		}
		return url.toString().replace(/\/+$/, '');
	} catch (error) {
		throw new Error(`${name} is not a valid WebSocket URL: ${value} (${(error as Error).message})`);
	}
}

function parseIntEnv(name: string, raw: string, min: number, max?: number): number {
	const value = Number.parseInt(raw, 10);
	if (!Number.isInteger(value) || value < min || (max !== undefined && value > max)) {
		const bound = max === undefined ? `>= ${min}` : `${min}-${max}`;
		throw new Error(`${name} must be an integer ${bound}, got: ${raw}`);
	}
	return value;
}

export function loadConfig(): Config {
	const instanceUrlRaw = env('INSTANCE_URL');
	const apiUrlRaw = env('API_URL');
	const gatewayUrlRaw = env('GATEWAY_URL');

	if (!instanceUrlRaw && !(apiUrlRaw && gatewayUrlRaw)) {
		throw new Error(
			'INSTANCE_URL is required (or set both API_URL and GATEWAY_URL for direct internal routing)',
		);
	}
	if (instanceUrlRaw && !(apiUrlRaw && gatewayUrlRaw) && (apiUrlRaw || gatewayUrlRaw)) {
		logger.warn(
			'Only one of API_URL/GATEWAY_URL is set; discovery overrides apply only when both are set',
		);
	}

	const instanceUrl = instanceUrlRaw ? parseHttpUrl('INSTANCE_URL', instanceUrlRaw) : '';

	const webAppBaseUrlRaw = env('WEB_APP_BASE_URL') ?? instanceUrlRaw;
	if (!webAppBaseUrlRaw) {
		throw new Error(
			'WEB_APP_BASE_URL is required when INSTANCE_URL is not set (links need a human-readable base URL)',
		);
	}

	const botToken = env('BOT_TOKEN');
	if (!botToken) throw new Error('BOT_TOKEN is required');
	if (!botToken.includes('.')) {
		logger.warn('BOT_TOKEN does not look like a bot token (expected "<application_id>.<secret>")');
	}

	const timeZone = env('TIMEZONE') ?? 'UTC';
	if (!isValidTimeZone(timeZone)) {
		throw new Error(`TIMEZONE is not a valid IANA time zone: ${timeZone}`);
	}

	const announceMode = (env('ANNOUNCE_MENTION') ?? 'none').toLowerCase();
	if (announceMode !== 'none' && announceMode !== 'everyone') {
		throw new Error(`ANNOUNCE_MENTION must be "none" or "everyone", got: ${announceMode}`);
	}

	const adminIds = new Set<Snowflake>();
	for (const raw of (env('EVENT_ADMINS') ?? '').split(',')) {
		const id = raw.trim();
		if (id === '') continue;
		if (!/^\d+$/.test(id)) {
			throw new Error(`EVENT_ADMINS contains a non-numeric user id: ${id}`);
		}
		adminIds.add(id);
	}

	// Channel names are written "#events" in the UI; tolerate the same form here.
	const eventsChannelRaw = env('EVENTS_CHANNEL_NAME') ?? 'events';
	const eventsChannel = eventsChannelRaw.replace(/^#/, '').trim().toLowerCase();
	if (eventsChannel === '') {
		throw new Error('EVENTS_CHANNEL_NAME must be a channel name or a channel ID');
	}

	return {
		instanceUrl,
		botToken,
		eventsChannel,
		timeZone,
		defaultEventHour: parseIntEnv('DEFAULT_EVENT_HOUR', env('DEFAULT_EVENT_HOUR') ?? '9', 0, 23),
		tickSeconds: parseIntEnv('TICK_SECONDS', env('TICK_SECONDS') ?? '30', 1),
		graceHours: parseIntEnv('GRACE_HOURS', env('GRACE_HOURS') ?? '24', 0),
		announceEveryone: announceMode === 'everyone',
		adminIds,
		webAppBaseUrl: parseHttpUrl('WEB_APP_BASE_URL', webAppBaseUrlRaw),
		apiUrl: apiUrlRaw ? parseHttpUrl('API_URL', apiUrlRaw) : undefined,
		gatewayUrl: gatewayUrlRaw ? parseWsUrl('GATEWAY_URL', gatewayUrlRaw) : undefined,
		dataDir: env('DATA_DIR') ?? 'data',
	};
}
