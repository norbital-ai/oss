import { bind_integration } from '../../../declarations.ts';

export default bind_integration('slack')({
	description: 'Slack: a bot in a workspace, its channels and direct messages.',
	driver: 'slack'
});
