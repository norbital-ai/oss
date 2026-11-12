// An integration instance: one external account of one definition (a number, a mailbox, a bot, a database, a calendar
// account). Every account is a durable runtime row; `owner` makes it personal (sync only).
// `status` is the host's (durable transitions only); `epoch` is the host's link fence and never readable. A member owns
// at most one instance of each definition. An envoy may be deployed on several instances (one hotline per entity).
// Managed through ordinary grants (admins bypass them): a create names the definition, and an owner for a personal
// instance or the envoy a workspace instance carries; an update deploys an envoy, pauses the instance or edits its
// configuration. The engine checks each against its definition (engine/integrations/instances.ts).
import { bind_system_model } from '../../../../decl/model.ts';

export default bind_system_model('sys_integration')({
	description: 'An integration instance: one external account of one integration definition.',
	record_label: 'record.name',
	fields: {
		integration: { kind: 'text' },
		name: { kind: 'text' },
		/** The member a personal instance belongs to. */
		owner: { kind: 'ref', to: 'sys_user', optional: true },
		envoy: { kind: 'text', optional: true },
		active: { kind: 'bool', default: true },
		configuration: { kind: 'json', default: {} },
		import_start: { kind: 'json', optional: true },
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
				'envoy',
				'active',
				'configuration',
				'import_start',
				'status',
				'revision'
			]
		}
	},
	create: {
		columns: { fields: ['integration', 'name', 'owner', 'envoy', 'configuration'] }
	},
	update: {
		columns: { fields: ['name', 'envoy', 'active', 'configuration', 'import_start'] }
	},
	delete: {}
});
