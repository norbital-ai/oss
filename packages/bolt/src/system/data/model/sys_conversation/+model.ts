// A conversation (§5.9, rules 57–63): an in-app agent thread, a sub-agent's, one chat or mail thread of an
// integration instance (`integration`, deleted with it), or an automation run's inference transcript (`run`). Grantable;
// written through the agent panel's actions.
import { model } from '../../../../decl/model.ts';

export default model('sys_conversation', {
	description:
		"A conversation: an agent thread or an integration's chat or mail thread, with its status, plan and goals.",
	label: 'title',
	fields: {
		created_at: { kind: 'instant', default: { now: '' } },
		title: { kind: 'text', optional: true },
		owner: { kind: 'text', optional: true },
		envoy: { kind: 'text', optional: true },
		thread: { kind: 'text', optional: true },
		kind: { kind: 'text', optional: true },
		/** The integration instance a chat or mail thread travels on. */
		integration: { kind: 'ref', to: 'sys_integration', optional: true, onDelete: 'cascade' },
		/** Provider membership for personal sync, shared by the conversation rather than copied into every message. */
		participants: { kind: 'json', optional: true },
		parent: { kind: 'text', optional: true },
		/** An automation run's inference (`ctx.ai.sys_2.infer`): its transcript, read-only, for administrators. */
		run: { kind: 'text', optional: true },
		/**
		 * Every upload: the files posted or received in it, oldest first, each naming its `message` (a stored file has its
		 * `sys_file` id; a received one too large to store has none). A message's files are these; its row holds none.
		 */
		inputs: { kind: 'json', default: [] },
		/** What its work made: downloads, screenshots, generated and sandbox files, oldest first. */
		outputs: { kind: 'json', default: [] },
		status: { kind: 'text', default: 'idle' },
		lease_until: { kind: 'instant', optional: true },
		model: { kind: 'text', default: 'default' },
		plan: { kind: 'json', optional: true },
		goals: { kind: 'json', optional: true },
		read: { kind: 'json', default: {} },
		revision: { kind: 'int', default: 1 },
		updated_at: { kind: 'instant', default: { now: '' } }
	},
	table: { primary: 'text' },
	read: { fields: 'all' }
});
