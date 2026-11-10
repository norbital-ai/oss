// An invitation: the authored team affiliation a member receives on acceptance. It names the person by their
// email, their mobile number, or both; either proves it. Administrators read it (X-18 identity); no grant.
import { model } from '../../../../decl/model.ts';

export default model('sys_invitation', {
	description: 'An invitation to join the workspace.',
	record_label: 'record.email',
	fields: {
		email: { kind: 'text', optional: true },
		/** A mobile number in international form. */
		phone: { kind: 'text', optional: true },
		external: { kind: 'bool', default: false },
		/** Who sent it. */
		invited_by: { kind: 'ref', to: 'sys_user', optional: true },
		/** The team handle the member receives, declared in source (`+team.ts`); writes refuse an undeclared handle. */
		team: { kind: 'text', format: 'team', optional: true },
		party: { kind: 'json', optional: true },
		expires_at: { kind: 'instant' },
		accepted_at: { kind: 'instant', optional: true },
		revoked_at: { kind: 'instant', optional: true },
		revision: { kind: 'int', default: 1 }
	},
	constraints: {
		addressed: { check: { or: [{ email: { is_null: false } }, { phone: { is_null: false } }] } }
	},
	table: { primary: 'text' },
	outputs: { default: { fields: 'all' } },
	indexes: { by_expression: { on: [{ lower: 'email' }] }, by_phone: { on: ['phone'] } }
});
