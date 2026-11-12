import { integration } from '../../../.norbital/integrations/mail.ts';

export default integration({ description: 'The notices mailbox', driver: 'email' });
