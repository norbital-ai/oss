// Who asked for an approval request (R3): the requesting member, read with their request.
import { bind_system_model } from '../../../../decl/model.ts';

export default bind_system_model('requestor')({
	description: 'The member who requested an approval.',
	record_label: 'record.user_id',
	fields: {
		user_id: { kind: 'text' },
		approval_request_id: { kind: 'ref', to: 'approval_request' }
	},
	table: { primary: 'text' },
	outputs: { default: { fields: 'all' } }
});
