import { bind_integration } from '../../../declarations.ts';

export default bind_integration('wechat')({
	description: 'WeChat: an official account and the chats of its followers.',
	driver: 'wechat'
});
