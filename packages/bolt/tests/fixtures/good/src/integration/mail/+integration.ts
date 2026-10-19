import { integration } from '../../../../../../src/index.ts';

const mail = integration('mail', {
	description: 'The notices mailbox',
	driver: 'email',
	feeds: { notices: { into: 'notices', from: 'messages', key: ['message_id'] } }
});
mail.feed('notices', {
	map: function* (mails) {
		return mails.map((m) =>
			m.deleted
				? { delete: { message_id: m.id } }
				: { upsert: { message_id: m.id, subject: m.subject } }
		);
	}
});
export default mail;
