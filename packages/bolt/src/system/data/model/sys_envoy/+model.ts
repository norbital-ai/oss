import { model } from '../../../../decl/model.ts';

export default model({
	description: 'Runtime envoy.',
	label: 'name',
	fields: {
		name: { kind: 'text' },
		task: { kind: 'text', default: '' },
		audience: { kind: 'enum', values: ['private', 'public'], default: 'private' },
		policies: { kind: 'json', default: [] },
		group_messages: { kind: 'enum', values: ['disabled', 'mention_or_reply', 'all'], default: 'disabled' },
		delegation: { kind: 'enum', values: ['disabled', 'enabled'], default: 'disabled' },
		triage: { kind: 'json', default: {} },
		active: { kind: 'bool', default: true },
		revision: { kind: 'int', default: 1 },
	},
	table: { primary: 'text' },
});
