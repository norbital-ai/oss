import { bind_integration } from '../../../declarations.ts';

export default bind_integration('discord')({
	description: 'Discord: a bot in a server, its channels and direct messages.',
	driver: 'discord'
});
