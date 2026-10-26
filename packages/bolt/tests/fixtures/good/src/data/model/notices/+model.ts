import { model } from '../../../../../../../src/index.ts';

export default model('notices', {
	description: 'Mirrored notices',
	label: 'subject',
	key: ['inbox', 'message_id'],
	fields: {
		message_id: { kind: 'text' },
		subject: { kind: 'text' },
		inbox: { kind: 'ref', to: 'sys_integration', where: { integration: { eq: 'mail' } } }
	},
	read: 'all',
	syncs: {
		messages: {
			with: 'mail',
			read: function* () {
				return { rows: [] };
			}
		}
	}
});
