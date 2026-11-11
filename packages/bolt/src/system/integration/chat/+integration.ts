import { bind_integration } from '../../../declarations.ts';

export default bind_integration('chat')({
	description: 'Any other chat platform: Teams, Messenger, LINE and more. A connection picks one.',
	driver: 'chat'
});
