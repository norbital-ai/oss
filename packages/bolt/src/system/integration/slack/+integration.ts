import { integration } from '../../../decl/runtime/integration.ts';

export default integration('slack', {
	description: 'Slack: a bot in a workspace, its channels and direct messages.',
	driver: 'slack'
});
