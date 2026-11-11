import { bind_integration } from '../../../../../../src/declarations.ts';

export default bind_integration('mail')({ description: 'The notices mailbox', driver: 'email' });
