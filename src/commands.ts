import type {Recurrence} from './types.js';
import type {WallDate, WallTime} from './time.js';
import {parseMonthDay, parseWallDate, parseWallTime} from './time.js';
import type {Snowflake} from './types.js';

/**
 * A date as written in a command. `year` is null for the MM-DD form, which is
 * only valid with --yearly (birthdays); the first occurrence year is resolved
 * against today's local date when the command runs.
 */
export interface CommandDate {
	year: number | null;
	month: number;
	day: number;
}

export type Command =
	| {kind: 'add'; recurrence: Recurrence; date: CommandDate; time: WallTime | null; title: string}
	| {kind: 'remove'; id: string}
	| {kind: 'list'; scope: 'month' | 'all'}
	| {kind: 'help'};

export interface ParsedCommand {
	command?: Command;
	error?: string;
}

const RECURRENCE_FLAGS: Record<string, Recurrence> = {
	'--yearly': 'yearly',
	'-y': 'yearly',
	'--monthly': 'monthly',
	'-m': 'monthly',
	'--weekly': 'weekly',
	'-w': 'weekly',
};

/** Matches both YYYY-MM-DD and MM-DD, for "looks like a date but is invalid" hints. */
const DATE_LIKE = /^\d{2,4}-\d{2}-\d{2}$/;

const ADD_USAGE =
	'Usage: @eventer add <date> [HH:MM] <title> [--yearly|--monthly|--weekly]\n' +
	'Dates are YYYY-MM-DD (or MM-DD with --yearly, e.g. birthdays).';

/**
 * Parse a message addressed to the bot.
 *
 * Returns null when the message is not addressed to the bot at all (no
 * leading mention), an `error` for addressed but malformed input, and a
 * `command` otherwise.
 */
export function parseCommand(content: string, botUserId: Snowflake): ParsedCommand | null {
	const trimmed = content.trim();
	const mention = [`<@${botUserId}>`, `<@!${botUserId}>`].find((candidate) =>
		trimmed.startsWith(candidate),
	);
	if (mention === undefined) return null;

	const tokens = trimmed.slice(mention.length).trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return {command: {kind: 'help'}};

	const head = tokens[0]!.toLowerCase();
	const rest = tokens.slice(1);
	switch (head) {
		case 'add':
			return parseAdd(rest);
		case 'remove':
		case 'rm':
		case 'delete':
			if (rest.length !== 1) {
				return {error: 'Usage: @eventer remove <id> — find ids with @eventer list'};
			}
			return {command: {kind: 'remove', id: rest[0]!.toLowerCase()}};
		case 'list':
			if (rest.length === 0) return {command: {kind: 'list', scope: 'month'}};
			if (rest.length === 1 && rest[0]!.toLowerCase() === 'all') {
				return {command: {kind: 'list', scope: 'all'}};
			}
			return {error: 'Usage: @eventer list [all]'};
		case 'help':
		case 'usage':
			return {command: {kind: 'help'}};
		default:
			return {error: `Unknown command "${tokens[0]}". Try @eventer help`};
	}
}

function parseAdd(tokens: string[]): ParsedCommand {
	// Pass 1: recurrence flags, position-independent ("add 03-15 --yearly X").
	let recurrence: Recurrence = 'once';
	for (const token of tokens) {
		const flag = RECURRENCE_FLAGS[token.toLowerCase()];
		if (flag === undefined) continue;
		if (recurrence !== 'once' && recurrence !== flag) {
			return {error: 'Pick a single recurrence flag: --yearly, --monthly, or --weekly.'};
		}
		recurrence = flag;
	}
	const positional = tokens.filter((token) => RECURRENCE_FLAGS[token.toLowerCase()] === undefined);

	// Pass 2: leading date/time tokens; everything after them is the title.
	let date: CommandDate | null = null;
	let time: WallTime | null = null;
	let index = 0;
	for (; index < positional.length; index++) {
		const token = positional[index]!;
		if (date === null) {
			const full = parseWallDate(token);
			if (full !== null) {
				date = {year: full.year, month: full.month, day: full.day};
				continue;
			}
			const monthDay = parseMonthDay(token);
			if (monthDay !== null) {
				date = {year: null, month: monthDay.month, day: monthDay.day};
				continue;
			}
		}
		if (time === null) {
			const parsed = parseWallTime(token);
			if (parsed !== null) {
				time = parsed;
				continue;
			}
		}
		break;
	}
	const title = positional.slice(index).join(' ').trim();

	if (title === '') return {error: ADD_USAGE};
	if (title.length > 128) return {error: 'Title is too long (max 128 characters).'};
	if (date === null) {
		const first = positional[0] ?? '';
		if (DATE_LIKE.test(first)) {
			return {error: `"${first}" is not a valid calendar date.`};
		}
		return {error: ADD_USAGE};
	}
	if (date.year === null && recurrence !== 'yearly') {
		return {error: 'MM-DD dates need --yearly (birthdays). One-off events use YYYY-MM-DD.'};
	}

	return {command: {kind: 'add', recurrence, date, time, title}};
}

/** Full WallDate for a CommandDate whose year is known. */
export function resolveWallDate(date: CommandDate, defaultYear: number): WallDate {
	return {year: date.year ?? defaultYear, month: date.month, day: date.day};
}
