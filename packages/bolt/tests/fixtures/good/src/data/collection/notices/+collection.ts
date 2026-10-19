import { collection } from '../../../../../../../src/index.ts';

export default collection('notices', { read: { fields: 'all' } });
