// A team (§5.11.1): the tree members and assignments hang from. Written by the admin verbs; readable by staff.
import { model } from '../../../../decl/model.ts';

export default model({
	description: 'A team of members; teams nest under a parent.',
	label: 'name',
	fields: {
		name: { kind: 'text' },
		revision: { kind: 'int', default: 1 },
	},
	table: { primary: 'text', indexes: [{ on: [{ lower: 'name' }], unique: true }] },
});
