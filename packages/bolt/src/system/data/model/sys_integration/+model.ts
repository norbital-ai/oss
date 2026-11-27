// An integration instance: one external account of one definition (a number, a mailbox, a bot, a database, a calendar
// account). Every account is a durable runtime row; `owner` makes it personal (sync only).
// `status` is the host's (durable transitions only; `status.failing` names each sync failing and since when); `epoch` is
// the host's link fence and never readable. `listen` is an optional connection-level capture scope (`ListeningScope`) on
// conversation integrations: messages outside it are not ingested. A member owns at most one instance of each definition.
// Envoys attach through `sys_envoy_channel` so one paired conversation channel may serve multiple scoped envoys.
// Managed through ordinary grants (admins bypass them): the engine checks each write against its definition
// (`engine/integrations/instances.ts`).
import { bind_system_model } from '../../../../decl/model.ts';

export default bind_system_model('sys_integration')({
	description: 'An integration instance: one external account of one integration definition.',
	record_label: 'record.name',
	fields: {
		integration: { kind: 'text' },
		name: { kind: 'text' },
		/** The member a personal instance belongs to. */
		owner: { kind: 'ref', to: 'sys_user', optional: true },
		active: { kind: 'bool', default: true },
		configuration: { kind: 'json', default: {} },
		import_start: { kind: 'json', optional: true },
		/** Connection-level capture scope (`ListeningScope`) for conversation integrations; null captures all. */
		listen: { kind: 'json', optional: true },
		/** Connection-level classifier & automation settings (`ClassifierConfig`) for conversation integrations; null defaults to smart mode. */
		classifier: { kind: 'json', optional: true },
		status: { kind: 'json', optional: true },
		epoch: { kind: 'text', optional: true },
		revision: { kind: 'int', default: 1 },
		/** The last committed edit; host status transitions leave it, so a sync's initialization generation follows edits only. */
		updated_at: { kind: 'instant', default: { var: 'now' } }
	},
	constraints: {
		one_per_member: { unique: ['owner', 'integration'], where: { owner: { is_null: false } } }
	},
	table: { primary: 'text' },
	outputs: {
		default: {
			fields: [
				'integration',
				'name',
				'owner',
				'active',
				'configuration',
				'import_start',
				'listen',
				'classifier',
				'status',
				'revision'
			]
		}
	},
	create: {
		fields: ['integration', 'name', 'owner', 'configuration', 'listen', 'classifier']
	},
	update: {
		fields: ['name', 'active', 'configuration', 'import_start', 'listen', 'classifier']
	},
	delete: {}
});
