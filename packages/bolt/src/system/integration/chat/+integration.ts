import { integration } from '../../../decl/runtime/integration.ts';

export default integration('chat', {
	description: 'Any other chat platform: Teams, Messenger, LINE and more. A connection picks one.',
	driver: 'chat'
});
