// A policy held by a member, a team or an API key (§5.11.1), optionally scoped to a record.
import { model } from '../../../../decl/model.ts';

export default model({
	description: 'A policy assigned to a member, a team or an API key.',
	label: 'policy',
	fields: {
		principal_type: { kind: 'enum', values: ['sys_user', 'sys_team', 'sys_api_key'] },
		principal: { kind: 'text' },
		policy: { kind: 'text' },
		scope: { kind: 'json', optional: true },
		revision: { kind: 'int', default: 1 },
	},
	index: ['principal'],
	table: { primary: 'text' },
});
