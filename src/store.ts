import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {logger} from './log.js';
import type {Recurrence, Snowflake} from './types.js';

export interface EventEntry {
	/** Short, human-typeable id (base36 counter). */
	id: string;
	guildId: Snowflake;
	title: string;
	creatorId: Snowflake;
	/** Display name captured at creation time, used for announcement credit. */
	creatorName: string;
	recurrence: Recurrence;
	/** Next scheduled occurrence as an ISO 8601 UTC timestamp. */
	nextOccurrence: string;
	/** Local calendar date (YYYY-MM-DD) of the next occurrence, in the configured time zone. */
	localDate: string;
	/** Local time of day (HH:MM) in the configured time zone; absent = all-day (fires at DEFAULT_EVENT_HOUR). */
	localTime?: string;
	createdAt: string;
}

interface StoreFile {
	/** Monotonic counter backing allocateId(). */
	nextIdNum: number;
	events: EventEntry[];
}

/**
 * Persistent list of scheduled events, one file per instance.
 *
 * Backed by a JSON file with atomic replace-on-write and debounced flushes,
 * so restarts never lose or double-fire events.
 */
export class EventStore {
	private entries: EventEntry[] = [];
	private nextIdNum = 1;
	private flushTimer: NodeJS.Timeout | undefined;
	private writing = Promise.resolve();

	constructor(private readonly filePath: string) {}

	async load(): Promise<void> {
		let raw: string;
		try {
			raw = await readFile(this.filePath, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				logger.info(`Store file ${this.filePath} does not exist yet; starting empty`);
				return;
			}
			throw error;
		}
		try {
			const parsed = JSON.parse(raw) as StoreFile;
			this.entries = Array.isArray(parsed.events) ? parsed.events : [];
			const storedCounter = Number(parsed.nextIdNum);
			this.nextIdNum = Number.isInteger(storedCounter) && storedCounter >= 1 ? storedCounter : 1;
			logger.info(`Loaded ${this.entries.length} events from ${this.filePath}`);
		} catch (error) {
			throw new Error(`Store file ${this.filePath} is corrupt: ${(error as Error).message}`);
		}
	}

	all(): readonly EventEntry[] {
		return this.entries;
	}

	forGuild(guildId: Snowflake): EventEntry[] {
		return this.entries.filter((entry) => entry.guildId === guildId);
	}

	get(id: string): EventEntry | undefined {
		const lower = id.toLowerCase();
		return this.entries.find((entry) => entry.id.toLowerCase() === lower);
	}

	add(entry: EventEntry): void {
		this.entries.push(entry);
		this.scheduleFlush();
	}

	update(entry: EventEntry): void {
		const index = this.entries.findIndex((candidate) => candidate.id === entry.id);
		if (index !== -1) this.entries[index] = entry;
		this.scheduleFlush();
	}

	remove(id: string): boolean {
		const lower = id.toLowerCase();
		const before = this.entries.length;
		this.entries = this.entries.filter((entry) => entry.id.toLowerCase() !== lower);
		const removed = this.entries.length < before;
		if (removed) this.scheduleFlush();
		return removed;
	}

	/** Allocate a fresh short id ("1", "2", ..., "a", ... in base36). */
	allocateId(): string {
		const id = this.nextIdNum.toString(36);
		this.nextIdNum += 1;
		this.scheduleFlush();
		return id;
	}

	/** Flush pending writes immediately (used on shutdown). */
	async flush(): Promise<void> {
		if (this.flushTimer !== undefined) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
		await this.writing;
		await this.write();
	}

	private scheduleFlush(): void {
		if (this.flushTimer !== undefined) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			this.writing = this.writing.then(() => this.write()).catch((error: unknown) => {
				logger.error('Failed to persist store', error);
			});
		}, 500);
		this.flushTimer.unref?.();
	}

	private async write(): Promise<void> {
		const file: StoreFile = {nextIdNum: this.nextIdNum, events: this.entries};
		const tmpPath = `${this.filePath}.tmp`;
		try {
			await mkdir(dirname(this.filePath), {recursive: true});
			await writeFile(tmpPath, JSON.stringify(file, null, '\t'), 'utf8');
			await rename(tmpPath, this.filePath);
		} catch (error) {
			logger.error(`Failed to write store file ${this.filePath}`, error);
		}
	}
}
