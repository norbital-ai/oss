import { bind_integration } from '../../../declarations.ts';

export default bind_integration('whatsapp')({
	description: 'WhatsApp: a paired WhatsApp number, its chats and groups.',
	driver: 'whatsapp'
});
