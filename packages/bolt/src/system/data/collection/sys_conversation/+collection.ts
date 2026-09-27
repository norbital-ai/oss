// Conversations (§5.9): grantable; written through the agent panel's actions.
import { collection } from '../../../../decl/collection.ts';

export default collection('sys_conversation', { read: { fields: 'all' } });
