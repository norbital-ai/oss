// Approval requestors (R3): read with their request.
import { collection } from '../../../../decl/collection.ts';

export default collection('requestor', { read: { fields: 'all' } });
