const LEVELS = {debug: 10, info: 20, warn: 30, error: 40} as const;
type LevelName = keyof typeof LEVELS;

const levelName = (process.env.LOG_LEVEL ?? 'info').toLowerCase() as LevelName;
const threshold = LEVELS[levelName] ?? LEVELS.info;

function log(level: LevelName, message: string, extra?: unknown) {
	if (LEVELS[level] < threshold) return;
	const ts = new Date().toISOString();
	const line = `${ts} [${level.toUpperCase().padEnd(5)}] ${message}`;
	switch (level) {
		case 'debug':
			extra === undefined ? console.debug(line) : console.debug(line, extra);
			break;
		case 'info':
			extra === undefined ? console.info(line) : console.info(line, extra);
			break;
		case 'warn':
			extra === undefined ? console.warn(line) : console.warn(line, extra);
			break;
		case 'error':
			extra === undefined ? console.error(line) : console.error(line, extra);
			break;
	}
}

export const logger = {
	debug: (message: string, extra?: unknown) => log('debug', message, extra),
	info: (message: string, extra?: unknown) => log('info', message, extra),
	warn: (message: string, extra?: unknown) => log('warn', message, extra),
	error: (message: string, extra?: unknown) => log('error', message, extra),
};
