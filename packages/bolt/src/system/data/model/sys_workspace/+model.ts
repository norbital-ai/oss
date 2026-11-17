// Mutable workspace display settings. Credentials and engine configuration stay in sys_config.
import { bind_system_model } from '../../../../decl/model.ts';
import { WORKSPACE_SETTINGS_ID } from '../../../settings.ts';

export default bind_system_model('sys_workspace')({
	description: 'Workspace display settings, editable by administrators. An absent name inherits the host display name.',
	record_label: 'record.name',
	fields: {
		name: { kind: 'text', optional: true, max: 120 },
		revision: { kind: 'int', default: 1 }
	},
	constraints: { singleton: { check: { id: { eq: WORKSPACE_SETTINGS_ID } } } },
	table: { primary: 'text' },
	outputs: { default: { fields: ['name', 'revision'] } },
	update: { fields: ['name'] }
});
