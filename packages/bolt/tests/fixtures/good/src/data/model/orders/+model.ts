import { model } from '../../../../../../../src/index.ts';

export default model({
	description: 'Sales orders', label: 'number',
	fields: {
		number: { kind: 'seq', pattern: 'SO-{0000}' },
		amount: { kind: 'money' },
		status: { kind: 'state', initial: 'draft', states: { draft: { to: ['placed'] }, placed: { edit: 'none' } } },
	},
});
