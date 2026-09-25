import {logger} from './log.js';
import type {EventEntry, EventStore} from './store.js';
import {advanceWallDate, formatWallDate, parseWallDate, parseWallTime, wallToInstant} from './time.js';

export interface SchedulerOptions {
	/** How often due events are checked, in seconds. */
	tickSeconds: number;
	/** How long after its scheduled time an event still announces. */
	graceHours: number;
	/** IANA time zone the events' local dates are interpreted in. */
	timeZone: string;
	/** Hour all-day events fire at (entries without an explicit time). */
	defaultEventHour: number;
}

/**
 * Due-event loop: every tick, events whose nextOccurrence has passed are
 * announced and then settled — recurring events advance to their next future
 * occurrence, one-offs are deleted.
 *
 * An event that came due while the bot was down still announces, as long as
 * it is within the grace window; anything older is settled silently so stale
 * entries cannot pile up. Failed announcements are retried on the next tick.
 */
export class Scheduler {
	private timer: NodeJS.Timeout | null = null;
	private ticking = false;

	constructor(
		private readonly options: SchedulerOptions,
		private readonly store: EventStore,
		/** Posts announcements; resolves to the ids that were announced successfully. */
		private readonly announce: (entries: EventEntry[]) => Promise<Set<string>>,
	) {}

	start(): void {
		if (this.timer !== null) return;
		// First tick runs almost immediately: events that came due while the
		// bot was down announce late instead of waiting a full interval.
		const firstTick = setTimeout(() => void this.tick(), 250);
		firstTick.unref?.();
		this.timer = setInterval(() => void this.tick(), this.options.tickSeconds * 1_000);
		this.timer.unref?.();
		logger.info(
			`Scheduler started (tick=${this.options.tickSeconds}s, grace=${this.options.graceHours}h, ` +
				`zone=${this.options.timeZone})`,
		);
	}

	stop(): void {
		if (this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	private async tick(): Promise<void> {
		if (this.ticking) return; // a slow announce must not overlap the next tick
		this.ticking = true;
		try {
			const now = Date.now();
			const graceMs = this.options.graceHours * 3_600_000;
			const due = this.store.all().filter((entry) => Date.parse(entry.nextOccurrence) <= now);
			if (due.length === 0) return;

			const toAnnounce = due.filter((entry) => now - Date.parse(entry.nextOccurrence) <= graceMs);
			const announced =
				toAnnounce.length === 0 ? new Set<string>() : await this.announce(toAnnounce);

			for (const entry of due) {
				const expired = now - Date.parse(entry.nextOccurrence) > graceMs;
				// Not announced and not expired: the announcement failed (or the
				// events channel is missing); keep the event and retry next tick.
				if (!announced.has(entry.id) && !expired) continue;
				this.settle(entry, now);
			}
		} catch (error) {
			logger.error('Scheduler tick failed', error);
		} finally {
			this.ticking = false;
		}
	}

	/** Advance a recurring event to its next future occurrence, or delete a one-off. */
	private settle(entry: EventEntry, now: number): void {
		if (entry.recurrence === 'once') {
			this.store.remove(entry.id);
			logger.info(`One-off event #${entry.id} "${entry.title}" completed`);
			return;
		}

		let date = parseWallDate(entry.localDate);
		if (date === null) {
			logger.error(`Event #${entry.id} has an invalid localDate "${entry.localDate}"; removing it`);
			this.store.remove(entry.id);
			return;
		}
		const time =
			entry.localTime !== undefined ? parseWallTime(entry.localTime) : null;
		const wallTime = time ?? {hour: this.options.defaultEventHour, minute: 0};

		let instant = wallToInstant(date, wallTime, this.options.timeZone);
		while (instant.getTime() <= now) {
			date = advanceWallDate(entry.recurrence, date);
			instant = wallToInstant(date, wallTime, this.options.timeZone);
		}

		entry.localDate = formatWallDate(date);
		entry.nextOccurrence = instant.toISOString();
		this.store.update(entry);
		logger.debug(`Event #${entry.id} "${entry.title}" advanced to ${entry.nextOccurrence}`);
	}
}
