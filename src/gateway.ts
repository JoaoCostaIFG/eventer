import {writeFile} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import WebSocket from 'ws';
import {logger} from './log.js';
import type {GatewayPayload, IdentifyData, ReadyData} from './types.js';

/** File whose mtime proves the connection is alive; the Docker healthcheck reads it. */
const HEARTBEAT_FILE = '/tmp/bot-heartbeat';

/**
 * Every Dispatch event this bot does not need. Fluxer has no intents system;
 * `ignored_events` in Identify is the traffic shaping mechanism, and a
 * suppressed event never enters the replay buffer.
 *
 * MESSAGE_CREATE stays ignored on purpose: the Gateway still delivers every
 * message that directly mentions the bot even when the event is suppressed
 * (the mention override in fluxer_gateway's session_dispatch), which is
 * exactly the command surface this bot wants. @everyone/@here/role-mention
 * strays arrive too and are discarded by the command parser.
 */
const IGNORED_EVENTS = [
	'SESSIONS_REPLACE',
	'AUTH_SESSION_CHANGE',
	'RATE_LIMITED',
	'USER_UPDATE',
	'USER_SETTINGS_UPDATE',
	'USER_GUILD_SETTINGS_UPDATE',
	'USER_NOTE_UPDATE',
	'USER_PINNED_DMS_UPDATE',
	'USER_CONNECTIONS_UPDATE',
	'WEBAUTHN_CREDENTIALS_UPDATE',
	'RELATIONSHIP_ADD',
	'RELATIONSHIP_UPDATE',
	'RELATIONSHIP_REMOVE',
	'SAVED_MESSAGE_CREATE',
	'SAVED_MESSAGE_DELETE',
	'RECENT_MENTION_DELETE',
	'FAVORITE_MEME_CREATE',
	'FAVORITE_MEME_UPDATE',
	'FAVORITE_MEME_DELETE',
	'GUILD_UPDATE',
	'GUILD_SYNC',
	'GUILD_ROLE_CREATE',
	'GUILD_ROLE_UPDATE',
	'GUILD_ROLE_UPDATE_BULK',
	'GUILD_ROLE_DELETE',
	'GUILD_EMOJIS_UPDATE',
	'GUILD_STICKERS_UPDATE',
	'CHANNEL_UPDATE_BULK',
	'CHANNEL_RECIPIENT_ADD',
	'CHANNEL_RECIPIENT_REMOVE',
	'WEBHOOKS_UPDATE',
	'INVITE_CREATE',
	'INVITE_DELETE',
	'GUILD_MEMBER_ADD',
	'GUILD_MEMBER_UPDATE',
	'GUILD_MEMBER_REMOVE',
	'GUILD_MEMBERS_CHUNK',
	'GUILD_MEMBER_LIST_UPDATE',
	'GUILD_AUDIT_LOG_ENTRY_CREATE',
	'GUILD_BAN_ADD',
	'GUILD_BAN_REMOVE',
	'PRESENCE_UPDATE',
	'PRESENCE_UPDATE_BULK',
	'PASSIVE_UPDATES',
	'MESSAGE_CREATE',
	'MESSAGE_UPDATE',
	'MESSAGE_DELETE',
	'MESSAGE_DELETE_BULK',
	'MESSAGE_ACK',
	'MESSAGE_REACTION_ADD',
	'MESSAGE_REACTION_ADD_MANY',
	'MESSAGE_REACTION_REMOVE',
	'MESSAGE_REACTION_REMOVE_ALL',
	'MESSAGE_REACTION_REMOVE_EMOJI',
	'TYPING_START',
	'CHANNEL_PINS_UPDATE',
	'CHANNEL_PINS_ACK',
	'VOICE_STATE_UPDATE',
	'VOICE_SERVER_UPDATE',
	'ENTRANCE_SOUND_PLAY',
	'CALL_CREATE',
	'CALL_UPDATE',
	'CALL_DELETE',
	'GUILD_COUNTS_UPDATE',
	'CHANNEL_MEMBER_COUNTS_UPDATE',
] as const;

/** Close codes that no amount of reconnecting will fix. */
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012]);

const OP = {
	DISPATCH: 0,
	HEARTBEAT: 1,
	IDENTIFY: 2,
	RESUME: 6,
	RECONNECT: 7,
	INVALID_SESSION: 9,
	HELLO: 10,
	HEARTBEAT_ACK: 11,
} as const;

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;

export interface GatewayEvents {
	ready: [user: ReadyData['user']];
	dispatch: [t: string, d: unknown];
	fatal: [error: Error];
}

export class GatewayClient extends EventEmitter<GatewayEvents> {
	private ws: WebSocket | null = null;
	private heartbeatTimer: NodeJS.Timeout | null = null;
	private heartbeatIntervalMs = 0;
	private lastSeq: number | null = null;
	private sessionId: string | null = null;
	private acked = true;
	private lastAckAt = 0;
	private reconnectAttempts = 0;
	private closedByUs = false;
	private stopped = false;
	private lastHeartbeatFileTouch = 0;

	constructor(
		private readonly url: string,
		private readonly token: string,
	) {
		super();
	}

	start(): void {
		this.stopped = false;
		this.connect();
	}

	stop(): void {
		this.stopped = true;
		this.closedByUs = true;
		this.clearHeartbeat();
		this.ws?.close(1000);
		this.ws = null;
	}

	private connect(): void {
		if (this.stopped) return;

		const url = this.url + (this.url.includes('?') ? '&' : '?') + 'v=1&encoding=json';
		logger.info(`Connecting to gateway ${this.url}`);
		this.closedByUs = false;

		const ws = new WebSocket(url);
		this.ws = ws;

		ws.on('open', () => {
			logger.debug('WebSocket opened');
		});

		ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
			if (isBinary) {
				logger.warn('Received binary frame on an uncompressed connection; ignoring');
				return;
			}
			this.onMessage(data.toString());
		});

		ws.on('error', (error: Error) => {
			// The close handler performs the reconnect; log for diagnosis only.
			logger.warn(`WebSocket error: ${error.message}`);
		});

		ws.on('close', (code: number, reason: WebSocket.RawData) => {
			this.onClose(code, reason.toString('utf8'));
		});
	}

	private send(payload: GatewayPayload): void {
		if (this.ws?.readyState !== WebSocket.OPEN) return;
		this.ws.send(JSON.stringify(payload));
	}

	private onMessage(raw: string): void {
		this.touchHeartbeatFile();

		let payload: GatewayPayload;
		try {
			payload = JSON.parse(raw) as GatewayPayload;
		} catch {
			logger.warn('Received undecodable gateway payload; ignoring');
			return;
		}

		switch (payload.op) {
			case OP.DISPATCH:
				this.onDispatch(payload);
				break;
			case OP.HEARTBEAT:
				// Server-requested immediate heartbeat; answer right away.
				this.sendHeartbeat();
				break;
			case OP.HELLO: {
				const interval = (payload.d as {heartbeat_interval?: number})?.heartbeat_interval;
				if (typeof interval !== 'number' || interval <= 0) {
					logger.error('HELLO carried no heartbeat_interval; reconnecting', payload.d);
					this.ws?.terminate();
					return;
				}
				this.startHeartbeat(interval);
				if (this.sessionId !== null) {
					logger.info(`Resuming session ${this.sessionId} at seq ${this.lastSeq ?? 0}`);
					this.send({op: OP.RESUME, d: {token: this.token, session_id: this.sessionId, seq: this.lastSeq ?? 0}});
				} else {
					this.identify();
				}
				break;
			}
			case OP.HEARTBEAT_ACK:
				this.acked = true;
				this.lastAckAt = Date.now();
				break;
			case OP.RECONNECT:
				logger.warn('Gateway requested reconnect (op 7); closing for resume');
				this.closedByUs = true;
				this.ws?.close(4000);
				break;
			case OP.INVALID_SESSION:
				// d is always literal false: the retained session is gone.
				logger.warn('Gateway reported an invalid session; identifying fresh');
				this.sessionId = null;
				this.lastSeq = null;
				this.clearHeartbeat();
				setTimeout(() => this.identify(), 1_500);
				break;
			default:
				// Unknown server opcodes are forward compatible: log and ignore.
				logger.debug(`Ignoring gateway opcode ${payload.op}`);
		}
	}

	private identify(): void {
		const d: IdentifyData = {
			token: this.token,
			properties: {
				os: process.platform,
				browser: 'eventer',
				device: 'eventer',
			},
			ignored_events: [...IGNORED_EVENTS],
		};
		this.send({op: OP.IDENTIFY, d});
		logger.info('Sent IDENTIFY');
	}

	private onDispatch(payload: GatewayPayload): void {
		if (typeof payload.s === 'number') {
			this.lastSeq = Math.max(this.lastSeq ?? 0, payload.s);
		}

		switch (payload.t) {
			case 'READY': {
				const d = payload.d as ReadyData;
				this.sessionId = d.session_id;
				this.reconnectAttempts = 0;
				logger.info(`Session ready (${d.session_id}); bot user ${d.user.username}`);
				this.emit('ready', d.user);
				break;
			}
			case 'RESUMED':
				this.reconnectAttempts = 0;
				logger.info('Session resumed');
				break;
			default:
				this.emit('dispatch', payload.t ?? '', payload.d);
		}
	}

	// -- Heartbeating ---------------------------------------------------------

	private startHeartbeat(intervalMs: number): void {
		this.clearHeartbeat();
		this.heartbeatIntervalMs = intervalMs;
		this.acked = true;
		this.lastAckAt = Date.now();
		this.heartbeatTimer = setInterval(() => this.heartbeatTick(), intervalMs);
		this.heartbeatTimer.unref?.();
	}

	private clearHeartbeat(): void {
		if (this.heartbeatTimer !== null) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}

	private heartbeatTick(): void {
		// The server drops us at 45s without an ack; give ourselves margin.
		if (!this.acked && Date.now() - this.lastAckAt > this.heartbeatIntervalMs + 10_000) {
			logger.warn('Heartbeat acknowledgement is overdue; forcing reconnect');
			this.ws?.terminate();
			return;
		}
		this.sendHeartbeat();
	}

	private sendHeartbeat(): void {
		this.acked = false;
		this.send({op: OP.HEARTBEAT, d: this.lastSeq});
	}

	// -- Reconnection ---------------------------------------------------------

	private onClose(code: number, reason: string): void {
		this.clearHeartbeat();
		if (this.stopped) return;

		if (FATAL_CLOSE_CODES.has(code)) {
			const hints: Record<number, string> = {
				4004: 'the bot token is invalid (or was rotated) — check BOT_TOKEN',
				4010: 'invalid shard configuration — this bot never shards, please report a bug',
				4011: 'the bot is in more than 2,500 guilds, which this bot does not support',
				4012: 'unsupported gateway protocol version — this bot needs a newer fluxer version',
			};
			this.emit('fatal', new Error(`Gateway closed with ${code} (${reason}): ${hints[code]}`));
			return;
		}

		const delay = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** this.reconnectAttempts);
		const jittered = delay * (0.8 + Math.random() * 0.4);
		this.reconnectAttempts += 1;
		const willResume = this.sessionId !== null;
		logger.warn(
			`Gateway closed (${code}${reason ? `: ${reason}` : ''}); ` +
				`${willResume ? 'resuming' : 'reconnecting'} in ${Math.round(jittered)}ms ` +
				`(attempt ${this.reconnectAttempts})`,
		);
		setTimeout(() => this.connect(), jittered);
	}

	// -- Liveness -------------------------------------------------------------

	private async touchHeartbeatFile(): Promise<void> {
		const now = Date.now();
		if (now - this.lastHeartbeatFileTouch < 5_000) return;
		this.lastHeartbeatFileTouch = now;
		try {
			await writeFile(HEARTBEAT_FILE, `${now}\n`, 'utf8');
		} catch {
			// Non-fatal: only Docker's healthcheck reads this file.
		}
	}
}
