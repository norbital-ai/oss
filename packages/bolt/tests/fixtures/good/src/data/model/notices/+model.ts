import { bind_model } from '../../../../../../../src/declarations.ts';

export default bind_model('notices')({
	description: 'Mirrored notices',
	record_label: 'record.subject',
	key: ['inbox', 'message_id'],
	fields: {
		message_id: { kind: 'text' },
		subject: { kind: 'text' },
		inbox: { kind: 'ref', to: 'sys_integration', where: { integration: { eq: 'mail' } } }
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
