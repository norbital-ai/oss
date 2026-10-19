import { integration } from '../../../decl/runtime/integration.ts';

export default integration('email', {
	description: 'Email: a mailbox, its threads in and out.',
	driver: 'email'
});
