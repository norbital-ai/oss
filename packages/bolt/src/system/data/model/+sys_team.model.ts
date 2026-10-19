// Readonly projection of the source team catalogue, preserving team foreign keys and directory reads.
import { model } from '../../../decl/model.ts';

export default model({
	description: 'An authored team; membership and relations use its stable source handle.',
	label: 'name',
	fields: {
		name: { kind: 'text' },
		revision: { kind: 'int', default: 1 }
	},
	table: { primary: 'text' }
});
