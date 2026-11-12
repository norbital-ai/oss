import { model } from '../../../../.norbital/models/notices.ts';

export default model({
	description: 'Mirrored notices',
	record_label: 'record.subject',
	fields: {
		message_id: { kind: 'text' },
		subject: { kind: 'text' },
		inbox: { kind: 'ref', to: 'sys_integration', where: { integration: { eq: 'mail' } } }
	},
	constraints: {
		one_message: { unique: ['inbox', 'message_id'], import_key: true }
	},
	outputs: { default: { fields: 'all' } },
	syncs: {
		messages: {
			with: 'mail',
			read: function* () {
				return { rows: [] };
			}
		}
	}
});
