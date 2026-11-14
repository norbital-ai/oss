// A member: the session principal. `party_id` is what the kernel directory grant compares for externals
//; only a staff member can be an admin. A member signs in with their email or their mobile number:
// each is unique among members (`phone_key` is the number's digits, as a WhatsApp handle compares it). Read as its
// `directory` output through the kernel directory or a read grant; written by the admin verbs. An `anonymous` user is a visitor's identity on
// a public app or a no-sign-in kiosk: no address, no member; signing in links it (session.ts `verify_code`), and the daily
// prune removes it 30 days after its last visit unless a record still references it.
import { bind_system_model } from '../../../../decl/model.ts';

export default bind_system_model('sys_user')({
	description: 'A member of the workspace: staff or an external party contact.',
	record_label: 'record.name',
	fields: {
		email: { kind: 'text', format: 'email', optional: true },
		name: { kind: 'text' },
		kind: { kind: 'enum', values: ['staff', 'external', 'anonymous'], default: 'staff' },
		active: { kind: 'bool', default: true },
		admin: { kind: 'bool', default: false },
		/** Grant origin: self-signup policies are resolved from the current source declaration. */
		signup: { kind: 'bool', default: false },
		/** A team handle declared in source (`+team.ts`); writes refuse an undeclared handle. */
		team: { kind: 'text', format: 'team', optional: true },
		party: { kind: 'json', optional: true },
		/** A mobile number in international form (`+6581234567`). */
		phone: { kind: 'text', optional: true },
		telegram: { kind: 'text', optional: true },
		/** Their Slack member id (`U…`): notices `via` a Slack connection reach them by direct message, and an envoy knows them there. */
		slack: { kind: 'text', optional: true },
		/** Their Discord user id (a snowflake), as `slack` for a Discord connection. */
		discord: { kind: 'text', optional: true },
		revision: { kind: 'int', default: 1 },
		created_at: { kind: 'instant', default: { var: 'now' } },
		/** Their last visit of their own, to the hour; an impersonator or an agent is not them. */
		last_seen: { kind: 'instant', optional: true },
		party_id: { kind: 'text', computed: "json_text(party, 'id')" },
		phone_key: { kind: 'text', computed: "regex_replace(phone, r'\\D', '')" }
	},

	constraints: {
		admin_staff: { check: { or: [{ admin: { eq: false } }, { kind: { eq: 'staff' } }] } }
	},
	table: {
		primary: 'text'
	},

	outputs: { default: { fields: 'all' }, directory: { fields: ['name'] } },
	indexes: {
		by_expression: { on: [{ lower: 'email' }], unique: true },
		by_phone_key: { on: ['phone_key'], unique: true },
		find: { text: ['name', 'email'] }
	}
});
