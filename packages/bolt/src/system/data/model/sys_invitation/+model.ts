// An invitation (§5.11.1): the team and assignments a new member receives on acceptance. It names the person by their
// email, their mobile number, or both; either proves it.
import { model } from '../../../../decl/model.ts';

export default model({
	description: 'An invitation to join the workspace.',
	label: 'email',
	fields: {
		email: { kind: 'text', optional: true },
		/** A mobile number in international form. */
		phone: { kind: 'text', optional: true },
		assignments: { kind: 'json', default: [] },
		external: { kind: 'bool', default: false },
		party: { kind: 'json', optional: true },
		expires_at: { kind: 'instant' },
		accepted_at: { kind: 'instant', optional: true },
		revoked_at: { kind: 'instant', optional: true },
		revision: { kind: 'int', default: 1 },
	},
	check: { addressed: { or: [{ email: { isNull: false } }, { phone: { isNull: false } }] } },
	table: { primary: 'text', indexes: [{ on: [{ lower: 'email' }] }, { on: ['phone'] }] },
});
