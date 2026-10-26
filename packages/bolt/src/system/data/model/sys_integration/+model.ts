// An integration instance: one external account of one definition (a number, a mailbox, a bot, a database, a calendar
// account). `id` is a `+workspace.ts` connection's slot name (`named`) or a uuidv7; `owner` makes it personal (sync only).
// `status` is the host's (durable transitions only); `epoch` is the host's link fence and never readable. A member owns
// at most one instance of each definition. An envoy may be deployed on several instances (one hotline per entity).
// Managed through ordinary grants (admins bypass them): a create names the definition, and an owner for a personal
// instance or the envoy a workspace instance carries; an update deploys an envoy, pauses the instance or edits its
// configuration. The engine checks each against the definition (engine/integrations/instances.ts); a named instance is
// `+workspace.ts`'s and is never deleted here.
import { model } from '../../../../decl/model.ts';

export default model('sys_integration', {
	description: 'An integration instance: one external account of one integration definition.',
	label: 'name',
	fields: {
		integration: { kind: 'text' },
		name: { kind: 'text' },
		/** The member a personal instance belongs to. */
		owner: { kind: 'ref', to: 'sys_user', optional: true },
		named: { kind: 'bool', default: false },
		envoy: { kind: 'text', optional: true },
		active: { kind: 'bool', default: true },
		configuration: { kind: 'json', default: {} },
		import_start: { kind: 'json', optional: true },
		status: { kind: 'json', optional: true },
		epoch: { kind: 'text', optional: true },
		revision: { kind: 'int', default: 1 }
	},
	unique: [
		{
			fields: ['owner', 'integration'],
			where: { owner: { isNull: false } },
			name: 'one_per_member'
		}
	],
	table: { primary: 'text' },
	read: {
		fields: [
			'integration',
			'name',
			'owner',
			'named',
			'envoy',
			'active',
			'configuration',
			'import_start',
			'status',
			'revision'
		]
	},
	create: { columns: ['integration', 'name', 'owner', 'envoy', 'configuration'] },
	update: { columns: ['name', 'envoy', 'active', 'configuration', 'import_start'] },
	delete: {}
});
