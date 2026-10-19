// Invitations (X-18 identity): administrators read them; no grant.
import { collection } from '../../../../decl/collection.ts';

export default collection('sys_invitation', { read: { fields: 'all' } });
