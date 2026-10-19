import { model } from '../../../../../../src/index.ts';

export default model({
	description: 'Mirrored notices',
	label: 'subject',
	key: ['inbox', 'message_id'],
	fields: { message_id: { kind: 'text' }, subject: { kind: 'text' } }
});
