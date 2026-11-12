// Engine configuration by key (the session signing secret, `ip_mac`, the integrations epoch, sealed secrets, the sign-up switch, the assistant's settings). Engine only.
import { bind_system_model } from '../../../../decl/model.ts';

export default bind_system_model('sys_config')({
	description: 'An engine setting by key.',
	record_label: 'record.key',
	fields: {
		key: { kind: 'text' },
		value: { kind: 'text' }
	},
	table: { primary: { field: 'key' } }
});
