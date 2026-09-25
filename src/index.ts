import 'dotenv/config';
import {FluxerApi} from './api.js';
import {loadConfig} from './config.js';
import {discoverEndpoints} from './discovery.js';
import {Eventer} from './eventer.js';
import {GatewayClient} from './gateway.js';
import {logger} from './log.js';
import {Scheduler} from './scheduler.js';
import {EventStore} from './store.js';
import type {Channel, GuildReadyData, MessageCreateData, Snowflake} from './types.js';

async function main(): Promise<void> {
	const config = loadConfig();
	logger.info(
		`Starting eventer: channel="${config.eventsChannel}" tz=${config.timeZone} ` +
			`tick=${config.tickSeconds}s grace=${config.graceHours}h`,
	);

	const endpoints = await discoverEndpoints({
		instanceUrl: config.instanceUrl,
		apiUrl: config.apiUrl,
		gatewayUrl: config.gatewayUrl,
	});
	logger.info(`API ${endpoints.api}; gateway ${endpoints.gateway}`);

	const api = new FluxerApi(endpoints.api, config.botToken);
	const store = new EventStore(`${config.dataDir}/events.json`);
	await store.load();

	const eventer = new Eventer(config, api, store);
	const scheduler = new Scheduler(
		{
			tickSeconds: config.tickSeconds,
			graceHours: config.graceHours,
			timeZone: config.timeZone,
			defaultEventHour: config.defaultEventHour,
		},
		store,
		(entries) => eventer.announce(entries),
	);

	const gateway = new GatewayClient(endpoints.gateway, config.botToken);
	gateway.on('ready', (user) => {
		eventer.setBotUserId(user.id);
		scheduler.start();
	});

	const shutdown = (reason: string) => {
		logger.info(`Shutting down (${reason})`);
		gateway.stop();
		scheduler.stop();
		void store.flush().finally(() => process.exit(process.exitCode ?? 0));
	};

	gateway.on('fatal', (error) => {
		logger.error(`Unrecoverable gateway error: ${error.message}`);
		process.exitCode = 1;
		shutdown('fatal gateway error');
	});

	gateway.on('dispatch', (t, d) => {
		switch (t) {
			case 'GUILD_CREATE': {
				const guild = d as GuildReadyData;
				eventer.onGuildCreate(guild.id, guild.channels);
				break;
			}
			case 'GUILD_DELETE': {
				const guild = d as {id: Snowflake; unavailable?: boolean};
				eventer.onGuildDelete(guild.id, guild.unavailable === true);
				break;
			}
			case 'CHANNEL_CREATE':
			case 'CHANNEL_UPDATE':
				eventer.onChannelUpdate(d as Channel);
				break;
			case 'CHANNEL_DELETE':
				eventer.onChannelDelete(d as Channel);
				break;
			case 'MESSAGE_CREATE':
				void eventer.onMessageCreate(d as MessageCreateData).catch((error: unknown) => {
					logger.error('Failed to handle MESSAGE_CREATE', error);
				});
				break;
			default:
				break;
		}
	});

	gateway.start();

	process.on('SIGINT', () => shutdown('SIGINT'));
	process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
	logger.error('Fatal startup error', error);
	process.exit(1);
});
