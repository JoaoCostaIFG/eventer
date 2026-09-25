/** Fluxer snowflakes are decimal strings. */
export type Snowflake = string;

/** Minimal shape of the partial user object embedded in messages. */
export interface PartialUser {
	id: Snowflake;
	username: string;
	discriminator: string;
	global_name?: string | null;
	avatar?: string | null;
	bot?: boolean;
}

export const GUILD_TEXT = 0;
export const GUILD_VOICE = 2;

/** Minimal channel object. */
export interface Channel {
	id: Snowflake;
	type: number;
	guild_id?: Snowflake;
	name?: string;
}

/** Minimal message object. */
export interface Message {
	id: Snowflake;
	channel_id: Snowflake;
	author: PartialUser;
	type: number;
	content: string;
	timestamp: string;
	mentions?: PartialUser[];
	mention_everyone?: boolean;
	attachments: unknown[];
}

/** Rich embed input for Create message. */
export interface EmbedInput {
	url?: string;
	title?: string;
	color?: number;
	timestamp?: string;
	description?: string;
	author?: {name: string; url?: string; icon_url?: string};
	image?: {url: string; description?: string};
	thumbnail?: {url: string; description?: string};
	footer?: {text: string; icon_url?: string};
	fields?: {name: string; value: string; inline?: boolean}[];
}

export interface CreateMessageBody {
	content?: string;
	embeds?: EmbedInput[];
	allowed_mentions?: {parse?: string[]; users?: string[]; roles?: string[]};
}

/** How an event repeats after each occurrence. */
export type Recurrence = 'once' | 'weekly' | 'monthly' | 'yearly';

// ---------------------------------------------------------------------------
// Gateway wire types

export interface GatewayPayload {
	op: number;
	d?: unknown;
	s?: number;
	t?: string;
}

export interface HelloData {
	heartbeat_interval: number;
}

export interface IdentifyData {
	token: string;
	properties: {os: string; browser: string; device: string};
	ignored_events?: string[];
}

export interface ResumeData {
	token: string;
	session_id: string;
	seq: number;
}

export interface ReadyData {
	session_id: string;
	user: PartialUser & {flags: number};
	guilds: {id: Snowflake; unavailable: boolean}[];
}

export interface GuildReadyData {
	id: Snowflake;
	channels?: Channel[];
	unavailable?: boolean;
}

/**
 * MESSAGE_CREATE dispatch: the complete message object extended with the
 * fields the Gateway adds (guild_id, channel_type, member, ...).
 */
export interface MessageCreateData extends Message {
	channel_type?: number;
	guild_id?: Snowflake;
	/** The author's guild member object with its `user` field removed. */
	member?: {nick?: string | null; roles?: Snowflake[]};
	mention_here?: boolean;
}
