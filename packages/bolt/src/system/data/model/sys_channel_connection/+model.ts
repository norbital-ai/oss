import { model } from '../../../../decl/model.ts';

export default model({
	description: 'Runtime channel connection.',
	label: 'name',
	fields: {
		name: { kind: 'text' },
		type: { kind: 'text' },
		configuration: { kind: 'json', default: {} },
		revision: { kind: 'int', default: 1 },
	},
	table: { primary: 'text' },
});
