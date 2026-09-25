/**
 * Time zone aware wall-clock date/time math, with zero dependencies.
 *
 * Events are defined by local wall-clock dates ("2026-12-25 18:00 in
 * Europe/Lisbon"); this module converts those to UTC instants and advances
 * recurring dates. All conversion goes through the Intl API, so daylight
 * saving transitions are handled by the runtime's time zone database.
 */

export interface WallDate {
	year: number;
	month: number; // 1-12
	day: number; // 1-31
}

export interface WallTime {
	hour: number; // 0-23
	minute: number; // 0-59
}

const pad = (value: number): string => String(value).padStart(2, '0');

// -- Parsing / formatting ---------------------------------------------------

export function parseWallDate(value: string): WallDate | null {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
	const year = Number(value.slice(0, 4));
	const month = Number(value.slice(5, 7));
	const day = Number(value.slice(8, 10));
	return isCalendarDate(year, month, day) ? {year, month, day} : null;
}

/** Month-day form used for yearly events (birthdays): "MM-DD". */
export function parseMonthDay(value: string): {month: number; day: number} | null {
	if (!/^\d{2}-\d{2}$/.test(value)) return null;
	const month = Number(value.slice(0, 2));
	const day = Number(value.slice(3, 5));
	// Checked against a leap year so Feb 29 is accepted.
	return isCalendarDate(2024, month, day) ? {month, day} : null;
}

export function parseWallTime(value: string): WallTime | null {
	if (!/^\d{2}:\d{2}$/.test(value)) return null;
	const hour = Number(value.slice(0, 2));
	const minute = Number(value.slice(3, 5));
	if (hour > 23 || minute > 59) return null;
	return {hour, minute};
}

export function formatWallDate(date: WallDate): string {
	return `${pad(date.year)}-${pad(date.month)}-${pad(date.day)}`;
}

export function formatWallTime(time: WallTime): string {
	return `${pad(time.hour)}:${pad(time.minute)}`;
}

export function isValidTimeZone(timeZone: string): boolean {
	try {
		new Intl.DateTimeFormat('en-US', {timeZone});
		return true;
	} catch {
		return false;
	}
}

// -- Zone conversion ----------------------------------------------------------

interface ZoneParts {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
	weekday: string;
}

const partFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
	let formatter = partFormatters.get(timeZone);
	if (formatter === undefined) {
		formatter = new Intl.DateTimeFormat('en-US', {
			timeZone,
			hour12: false,
			weekday: 'short',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
		});
		partFormatters.set(timeZone, formatter);
	}
	return formatter;
}

function zoneParts(ms: number, timeZone: string): ZoneParts {
	const parts = partsFormatter(timeZone).formatToParts(new Date(ms));
	const number = (type: string): number =>
		Number(parts.find((part) => part.type === type)?.value ?? '0');
	return {
		year: number('year'),
		month: number('month'),
		day: number('day'),
		// hour12:false can still report "24" in some runtimes; normalize to 0.
		hour: number('hour') % 24,
		minute: number('minute'),
		second: number('second'),
		weekday: parts.find((part) => part.type === 'weekday')?.value ?? '',
	};
}

/** Offset of `timeZone` from UTC at the given instant, in milliseconds. */
function zoneOffsetMs(ms: number, timeZone: string): number {
	const parts = zoneParts(ms, timeZone);
	const asUtc = Date.UTC(
		parts.year,
		parts.month - 1,
		parts.day,
		parts.hour,
		parts.minute,
		parts.second,
	);
	return asUtc - ms;
}

/** The UTC instant of a wall-clock date and time in `timeZone` (DST aware). */
export function wallToInstant(date: WallDate, time: WallTime, timeZone: string): Date {
	const naive = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute);
	const offset = zoneOffsetMs(naive, timeZone);
	let instant = naive - offset;
	// A DST transition can sit between the guess and the answer; refine once.
	const refined = zoneOffsetMs(instant, timeZone);
	if (refined !== offset) instant = naive - refined;
	return new Date(instant);
}

/** The local calendar date of an instant in `timeZone`. */
export function instantToWallDate(instant: Date, timeZone: string): WallDate {
	const parts = zoneParts(instant.getTime(), timeZone);
	return {year: parts.year, month: parts.month, day: parts.day};
}

const MONTHS_SHORT = [
	'Jan',
	'Feb',
	'Mar',
	'Apr',
	'May',
	'Jun',
	'Jul',
	'Aug',
	'Sep',
	'Oct',
	'Nov',
	'Dec',
] as const;

/** "Sun, 15 Mar 2027" or — with a time — "Fri, 25 Dec 2030 at 18:00". */
export function formatInstant(instant: Date, timeZone: string, includeTime: boolean): string {
	const parts = zoneParts(instant.getTime(), timeZone);
	let out = `${parts.weekday}, ${parts.day} ${MONTHS_SHORT[parts.month - 1]!} ${parts.year}`;
	if (includeTime) out += ` at ${pad(parts.hour)}:${pad(parts.minute)}`;
	return out;
}

// -- Calendar arithmetic ------------------------------------------------------

function isCalendarDate(year: number, month: number, day: number): boolean {
	return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

export function daysInMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function addWallDays(date: WallDate, days: number): WallDate {
	const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day) + days * 86_400_000);
	return {
		year: shifted.getUTCFullYear(),
		month: shifted.getUTCMonth() + 1,
		day: shifted.getUTCDate(),
	};
}

export function addWallMonths(date: WallDate, months: number): WallDate {
	const total = date.year * 12 + (date.month - 1) + months;
	const year = Math.floor(total / 12);
	const month = (total % 12) + 1;
	// Clamp to the target month's length: Jan 31 -> Feb 28/29, Feb 29 -> Feb 28.
	return {year, month, day: Math.min(date.day, daysInMonth(year, month))};
}

export function addWallYears(date: WallDate, years: number): WallDate {
	return addWallMonths(date, years * 12);
}

/** The next calendar date of a recurring series. */
export function advanceWallDate(
	recurrence: 'weekly' | 'monthly' | 'yearly',
	date: WallDate,
): WallDate {
	switch (recurrence) {
		case 'weekly':
			return addWallDays(date, 7);
		case 'monthly':
			return addWallMonths(date, 1);
		case 'yearly':
			return addWallYears(date, 1);
	}
}

function isBeforeWall(a: WallDate, b: WallDate): boolean {
	return a.year * 10_000 + a.month * 100 + a.day < b.year * 10_000 + b.month * 100 + b.day;
}

/**
 * First occurrence of the series on or after `today` (calendar comparison).
 *
 * Inclusive of today, so an event added on its own day still fires today even
 * when the scheduled hour has already passed (the scheduler announces late).
 */
export function firstOccurrence(
	recurrence: 'weekly' | 'monthly' | 'yearly',
	base: WallDate,
	today: WallDate,
): WallDate {
	let date = base;
	for (let guard = 0; isBeforeWall(date, today) && guard < 10_000; guard++) {
		date = advanceWallDate(recurrence, date);
	}
	return date;
}
