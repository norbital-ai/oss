// The workspace log (X-18 ledger, §5.12): administrators only.
import { collection } from '../../../../decl/collection.ts';

export default collection('sys_event', { read: { fields: 'all' } });
