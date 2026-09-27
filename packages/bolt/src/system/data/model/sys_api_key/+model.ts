// An API key (§5.11.2): `Authorization: Bearer nbk_<prefix>_<secret>`, stored as the secret's SHA-256.
import { model } from '../../../../decl/model.ts';

export default model({
	description: 'An API key: its name, lookup prefix and the hash of its secret.',
	label: 'name',
	fields: {
		name: { kind: 'text' },
		prefix: { kind: 'text', unique: true },
		hash: { kind: 'text' },
		revoked_at: { kind: 'instant', optional: true },
		last_used_at: { kind: 'instant', optional: true },
		revision: { kind: 'int', default: 1 },
		created_at: { kind: 'instant', default: { now: '' } },
	},
	table: { primary: 'text' },
});
