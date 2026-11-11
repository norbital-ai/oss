import { bind_integration } from '../../../declarations.ts';

export default bind_integration('telegram')({
	description: 'Telegram: a bot, its chats and groups.',
	driver: 'telegram'
});
