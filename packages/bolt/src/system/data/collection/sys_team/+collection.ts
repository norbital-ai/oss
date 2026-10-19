// Teams (X-18 identity): staff read them; written by the admin verbs.
import { collection } from '../../../../decl/collection.ts';

export default collection('sys_team', { read: { fields: 'all' } });
