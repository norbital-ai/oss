// A sign-in session (§5.11.2): the token is stored only as its SHA-256. Engine only: no collection.
import { model } from '../../../../decl/model.ts';

export default model({
	description: 'A signed-in session of a member.',
	label: 'via',
	fields: {
		token_hash: { kind: 'text', unique: true },
		via: { kind: 'enum', values: ['code', 'invitation', 'signup', 'host'] },
		created_at: { kind: 'instant' },
		expires_at: { kind: 'instant' },
		refreshed_at: { kind: 'instant' },
	},
	table: { primary: 'text' },
});
