// Members (X-18 identity): read through the kernel directory (rule 35a) or a read grant; written by the admin verbs.
import { collection } from '../../../../decl/collection.ts';

export default collection('sys_user', { read: { fields: 'all' } });
