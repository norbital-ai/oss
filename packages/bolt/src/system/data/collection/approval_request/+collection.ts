// Approval requests (R3): read by their participants; written by bolt.approvals and the engine.
import { collection } from '../../../../decl/collection.ts';

export default collection('approval_request', { read: { fields: 'all' } });
