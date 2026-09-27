import { collection } from '../../../../../../../src/index.ts';
export default collection('customers' as 'orders', { read: { fields: 'all' } });
