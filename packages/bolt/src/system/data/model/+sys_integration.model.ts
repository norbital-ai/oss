// An integration instance: one external account of one definition (a number, a mailbox, a bot, a database, a calendar
// account). `id` is a `+workspace.ts` connection's slot name (`named`) or a uuidv7; `owner` makes it personal (sync only).
// `status` is the host's (durable transitions only); `epoch` is the host's link fence and never readable. A member owns
// at most one instance of each definition. An envoy may be deployed on several instances (one hotline per entity).
import { model } from '../../../decl/model.ts';

export default model({
	description: 'An integration instance: one external account of one integration definition.',
	label: 'name',
	fields: {
		integration: { kind: 'text' },
		name: { kind: 'text' },
		named: { kind: 'bool', default: false },
		envoy: { kind: 'text', optional: true },
		active: { kind: 'bool', default: true },
		configuration: { kind: 'json', default: {} },
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
	table: { primary: 'text' }
});
