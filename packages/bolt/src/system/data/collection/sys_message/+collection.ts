// Messages (§5.9): grantable; written through the agent panel's actions and the channels.
import { collection } from '../../../../decl/collection.ts';

export default collection('sys_message', { read: { fields: 'all' } });
