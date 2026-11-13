// An envoy: the tenant-created agent that answers outside senders on its channel instances. Its authority is
// the declared policies by handle; its `task` is the supplementary prompt added to the workspace agent's brief. The
// channel's credentials never live here: `sys_integration` owns the link and `bolt_credential` seals the secret.
// A sender counts as a member only where the platform proves who they are (WhatsApp and Telegram accounts, an
// authenticated email domain); a private envoy admits only them, and a direct message joins their authority. While a
// turn runs, a direct message steers it at once, in a group only an addressed one. Typing shows from the hold through
// the turn, renewed every 10 s until the first reply. A change or delete takes effect on later admission.
import { bind_system_model } from '../../../../decl/model.ts';

export default bind_system_model('sys_envoy')({
	description: 'An envoy: the agent that answers outside senders on its connected channels.',
	record_label: 'record.name',
	fields: {
		name: { kind: 'text' },
		audience: { kind: 'enum', values: ['private', 'public'], default: 'private' },
		/** The supplementary prompt added to the workspace agent's brief for this envoy's turns. */
		task: { kind: 'text', format: 'markdown', default: '' },
		/** Policy handles declared in source; the envoy's whole authority. */
		policies: { kind: 'text', many: true, default: [] },
		group_messages: {
			kind: 'enum',
			values: ['disabled', 'mention_or_reply', 'all'],
			default: 'mention_or_reply'
		},
		delegation: { kind: 'enum', values: ['enabled', 'disabled'], default: 'disabled' },
		/**
		 * The smart throttle, where the host binds System 1: each message it may answer is read against the conversation's
		 * recent window. A message that reads partial is held at most 3 s, once (a sender typing extends it within the
		 * cap); in a group, what is not for the assistant is filtered (a mention, a reply or its name needs no decision; a
		 * direct conversation is never filtered). Filtered messages stay in the conversation as asides.
		 */
		triage: { kind: 'bool', default: false },
		triage_scope: {
			kind: 'enum',
			values: ['dm', 'group', 'all'],
			default: 'all',
			hidden: true
		},
		dm: { kind: 'enum', values: ['union', 'envoy'], default: 'union' },
		active: { kind: 'bool', default: true },
		created_at: { kind: 'instant', default: { var: 'now' } },
		revision: { kind: 'int', default: 1 }
	},
	table: { primary: 'uuid' },
	outputs: { default: { fields: 'all' } },
	create: {
		columns: {
			fields: [
				'name',
				'audience',
				'task',
				'policies',
				'group_messages',
				'delegation',
				'triage',
				'triage_scope',
				'dm'
			]
		}
	},
	update: {
		columns: {
			fields: [
				'name',
				'audience',
				'task',
				'policies',
				'group_messages',
				'delegation',
				'triage',
				'triage_scope',
				'dm',
				'active'
			]
		}
	},
	delete: {}
});
