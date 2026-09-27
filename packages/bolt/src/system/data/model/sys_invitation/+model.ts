// An invitation (§5.11.1): the team and assignments a new member receives on acceptance.
import { model } from '../../../../decl/model.ts';

export default model({
	description: 'An invitation to join the workspace.',
	label: 'email',
	fields: {
		email: { kind: 'text' },
		assignments: { kind: 'json', default: [] },
		external: { kind: 'bool', default: false },
		party: { kind: 'json', optional: true },
		expires_at: { kind: 'instant' },
		accepted_at: { kind: 'instant', optional: true },
		revoked_at: { kind: 'instant', optional: true },
		revision: { kind: 'int', default: 1 },
	},
	table: { primary: 'text', indexes: [{ on: [{ lower: 'email' }] }] },
});
