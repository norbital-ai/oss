// An envoy (P22, §4.4): the tenant-created agent that answers outside senders on its channel instances. Its authority is
// the declared policies by handle; its `task` is the supplementary prompt added to the workspace agent's brief. The
// channel's credentials never live here: `sys_integration` owns the link and `bolt_credential` seals the secret.
import { model } from '../../../../decl/model.ts';

export default model('sys_envoy', {
	description: 'An envoy: the agent that answers outside senders on its connected channels.',
	label: 'name',
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
		triage: { kind: 'bool', default: false },
		dm: { kind: 'enum', values: ['union', 'envoy'], default: 'union' },
		active: { kind: 'bool', default: true },
		created_at: { kind: 'instant', default: { var: 'now' } },
		revision: { kind: 'int', default: 1 }
	},
	table: { primary: 'uuid' },
	read: 'all',
	create: {
		columns: {
			sys_envoy: [
				'name',
				'audience',
				'task',
				'policies',
				'group_messages',
				'delegation',
				'triage',
				'dm'
			]
		}
	},
	update: {
		columns: {
			sys_envoy: [
				'name',
				'audience',
				'task',
				'policies',
				'group_messages',
				'delegation',
				'triage',
				'dm',
				'active'
			]
		}
	},
	delete: {}
});
