// A member (§5.11.1): the session principal. `party_id` is what the kernel directory grant compares for externals
// (rule 35a); only a staff member can be an admin (rule 38c).
import { model } from '../../../../decl/model.ts';

export default model({
	description: 'A member of the workspace: staff or an external party contact.',
	label: 'name',
	fields: {
		email: { kind: 'text', format: 'email', optional: true },
		name: { kind: 'text' },
		kind: { kind: 'enum', values: ['staff', 'external'], default: 'staff' },
		active: { kind: 'bool', default: true },
		admin: { kind: 'bool', default: false },
		party: { kind: 'json', optional: true },
		phone: { kind: 'text', optional: true },
		telegram: { kind: 'text', optional: true },
		revision: { kind: 'int', default: 1 },
		created_at: { kind: 'instant', default: { now: '' } },
	},
	computed: { party_id: { kind: 'text', expr: { jsonText: [{ field: 'party' }, 'id'] } } },
	check: { admin_staff: { or: [{ admin: { eq: false } }, { kind: { eq: 'staff' } }] } },
	table: { primary: 'text', indexes: [{ on: [{ lower: 'email' }], unique: true }] },
});
