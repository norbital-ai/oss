// Integration instances, managed through ordinary grants (admins bypass them). A create names the definition, and an
// owner for a personal instance or the envoy a workspace instance carries; an update deploys an envoy, pauses the instance or edits its configuration. The
// engine's transform (engine/integrations/instances.ts) checks each against the definition; a named instance is
// `+workspace.ts`'s and is never deleted here. The host's fence (`epoch`) is never exposed.
import { collection } from '../../../../decl/collection.ts';

export default collection('sys_integration', {
	read: {
		fields: [
			'integration',
			'name',
			'owner',
			'named',
			'envoy',
			'active',
			'configuration',
			'status',
			'revision'
		]
	},
	create: { input: { columns: ['integration', 'name', 'owner', 'envoy', 'configuration'] } },
	update: { input: { columns: ['name', 'envoy', 'active', 'configuration'] } },
	delete: {}
});
