// An invitation: the authored team affiliation a member receives on acceptance. It names the person by their
// email, their mobile number, or both; either proves it.
import { model } from '../../../decl/model.ts';

export default model({
	description: 'An invitation to join the workspace.',
	label: 'email',
	fields: {
		email: { kind: 'text', optional: true },
		/** A mobile number in international form. */
		phone: { kind: 'text', optional: true },
		external: { kind: 'bool', default: false },
		/** The team handle the member receives, declared in source (`+team.ts`); writes refuse an undeclared handle. */
		team: { kind: 'text', format: 'team', optional: true },
		party: { kind: 'json', optional: true },
		expires_at: { kind: 'instant' },
		accepted_at: { kind: 'instant', optional: true },
		revoked_at: { kind: 'instant', optional: true },
		revision: { kind: 'int', default: 1 }
	},
	check: { addressed: { or: [{ email: { isNull: false } }, { phone: { isNull: false } }] } },
	table: { primary: 'text', indexes: [{ on: [{ lower: 'email' }] }, { on: ['phone'] }] }
});
