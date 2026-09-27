// Who asked for an approval request (R3): the requesting member.
import { model } from '../../../../decl/model.ts';

export default model({
	description: 'The member who requested an approval.',
	label: 'user_id',
	fields: {
		user_id: { kind: 'text' },
	},
	table: { primary: 'text' },
});
