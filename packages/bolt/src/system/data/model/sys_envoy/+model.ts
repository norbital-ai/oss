// An envoy (P22, §4.4): the tenant-created agent that answers outside senders on its channel instances. Its authority is
// the declared policies by handle; its `task` is the supplementary prompt added to the workspace agent's brief. The
// channel's credentials never live here: `sys_integration` owns the link and `bolt_credential` seals the secret.
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
