// Assignments (X-18 identity): a member reads their own; written by the admin verbs.
import { collection } from '../../../../decl/collection.ts';

export default collection('sys_assignment', { read: { fields: 'all' } });
