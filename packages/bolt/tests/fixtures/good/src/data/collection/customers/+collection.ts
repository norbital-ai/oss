import { collection } from '../../../../../../../src/index.ts';

export default collection('customers', { read: { fields: 'all' }, create: { input: { columns: ['name', 'rating'] } } });
