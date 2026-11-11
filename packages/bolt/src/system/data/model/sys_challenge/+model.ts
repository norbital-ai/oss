// A pending sign-in code (rule 38a), keyed by the address's MAC. Engine only: not exposed.
import { bind_model } from '../../../../declarations.ts';

export default bind_model('sys_challenge')({
	description: 'A sign-in code sent to an address, awaiting its entry.',
	record_label: 'record.address_mac',
	fields: {
		address_mac: { kind: 'text' },
		code_mac: { kind: 'text' },
		attempts: { kind: 'int', default: 0 },
		expires_at: { kind: 'instant' }
	},
	table: { primary: { field: 'address_mac' } }
});
