import { integration } from '../../../decl/runtime/integration.ts';

export default integration('wechat', {
	description: 'WeChat: an official account and the chats of its followers.',
	driver: { name: 'wechat', read: 'deliveries', conversation: { kind: 'chat', handle: null } }
});
