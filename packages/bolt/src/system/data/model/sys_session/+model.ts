// A sign-in session (§5.11.2): the token is stored only as its SHA-256. Engine only: not exposed.
import { model } from '../../../../decl/model.ts';

export default model('sys_session', {
	description: 'A signed-in session of a member.',
	label: 'via',
	fields: {
		token_hash: { kind: 'text', unique: true },
		/** The member signed in; the session is deleted with them. */
		user: { kind: 'ref', to: 'sys_user', onDelete: 'cascade' },
		/** The administrator previewing as `user`. */
		impersonated_by: { kind: 'ref', to: 'sys_user', optional: true },
		via: { kind: 'enum', values: ['code', 'invitation', 'signup', 'host'] },
		created_at: { kind: 'instant' },
		expires_at: { kind: 'instant' },
		refreshed_at: { kind: 'instant' },
		/** Minted for the agent's browser: the conversation it acts in (`Authority.agent`). */
		agent: { kind: 'text', optional: true }
	},
	table: { primary: 'text' }
});
