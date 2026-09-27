// Notices (L-BOLT-354): a member's inbox; written by the notice piece of a write.
import { collection } from '../../../../decl/collection.ts';

export default collection('sys_notification', { read: { fields: 'all' } });
