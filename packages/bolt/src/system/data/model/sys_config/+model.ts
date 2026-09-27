// Engine configuration by key (the session signing secret, `ip_mac`, channel epochs, paused syncs). Engine only.
import { model } from '../../../../decl/model.ts';

export default model({
	description: 'An engine setting by key.',
	label: 'key',
	fields: {
		key: { kind: 'text' },
		value: { kind: 'text' },
	},
	table: { primary: { field: 'key' } },
});
