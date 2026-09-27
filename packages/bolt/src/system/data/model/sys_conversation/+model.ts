// A conversation (§5.9, rules 57–63): an in-app agent thread, a sub-agent's, or one provider chat or mail thread.
import { model } from '../../../../decl/model.ts';

export default model({
	description: 'A conversation: an agent thread or a channel chat, with its status, plan and goals.',
	label: 'title',
	fields: {
		created_at: { kind: 'instant', default: { now: '' } },
		title: { kind: 'text', optional: true },
		owner: { kind: 'text', optional: true },
		envoy: { kind: 'text', optional: true },
		channel: { kind: 'text', optional: true },
		thread: { kind: 'text', optional: true },
		kind: { kind: 'text', optional: true },
		parent: { kind: 'text', optional: true },
		status: { kind: 'text', default: 'idle' },
		lease_until: { kind: 'instant', optional: true },
		model: { kind: 'text', default: 'default' },
		plan: { kind: 'json', optional: true },
		goals: { kind: 'json', optional: true },
		read: { kind: 'json', default: {} },
		revision: { kind: 'int', default: 1 },
		updated_at: { kind: 'instant', default: { now: '' } },
	},
	table: { primary: 'text' },
});
