// An API key: `Authorization: Bearer nbk_<prefix>_<secret>`, stored as the secret's SHA-256. Administrators
// read it (X-18 identity); no grant, and never the secret's hash.
import { bind_system_model } from '../../../../decl/model.ts';

export default bind_system_model('sys_api_key')({
	description: 'An API key: its name, lookup prefix and the hash of its secret.',
	record_label: 'record.name',
	fields: {
		name: { kind: 'text' },
		prefix: { kind: 'text' },
		hash: { kind: 'text' },
		/** The team handle the key acts as, declared in source (`+team.ts`); writes refuse an undeclared handle. */
		team: { kind: 'text', format: 'team', optional: true },
		/** Who issued it. */
		created_by: { kind: 'ref', to: 'sys_user', optional: true },
		revoked_at: { kind: 'instant', optional: true },
		last_used_at: { kind: 'instant', optional: true },
		revision: { kind: 'int', default: 1 },
		created_at: { kind: 'instant', default: { var: 'now' } }
	},
	constraints: { prefix: { unique: ['prefix'] } },
	table: { primary: 'text' },
	outputs: {
		default: {
			fields: [
				'name',
				'prefix',
				'team',
				'created_by',
				'revoked_at',
				'last_used_at',
				'revision',
				'created_at'
			]
		}
	}
});
