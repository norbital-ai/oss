import { model } from '../../../../decl/model.ts';

export default model({
	description: 'Runtime envoy channel.',
	label: 'channel_connection',
	fields: {
		revision: { kind: 'int', default: 1 },
	},
	unique: [{ fields: ['channel_connection'] }],
	table: { primary: 'text' },
});
