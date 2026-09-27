// A pending sign-in code (rule 38a), keyed by the address's MAC. Engine only: no collection.
import { model } from '../../../../decl/model.ts';

export default model({
	description: 'A sign-in code sent to an address, awaiting its entry.',
	label: 'address_mac',
	fields: {
		address_mac: { kind: 'text' },
		code_mac: { kind: 'text' },
		attempts: { kind: 'int', default: 0 },
		expires_at: { kind: 'instant' },
	},
	table: { primary: { field: 'address_mac' } },
});
