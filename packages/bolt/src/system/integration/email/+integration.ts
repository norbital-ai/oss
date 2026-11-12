import { bind_integration } from '../../../declarations.ts';

export default bind_integration('email')({
	description: 'Email: a mailbox, its threads in and out.',
	driver: 'email'
});
