// Who asked for an approval request (R3): the requesting member, read with their request.
import { model } from '../../../../decl/model.ts';

export default model('requestor', {
	description: 'The member who requested an approval.',
	label: 'user_id',
	fields: {
		user_id: { kind: 'text' },
		approval_request_id: { kind: 'ref', to: 'approval_request' }
	},
	table: { primary: 'text' },
	read: { fields: 'all' }
});
