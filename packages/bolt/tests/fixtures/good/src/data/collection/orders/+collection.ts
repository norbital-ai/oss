import { collection } from '../../../../../../../src/index.ts';

const c = collection('orders', {
	read: { fields: 'all' },
	create: { input: { columns: ['customer', 'amount'] } },
	queries: { count_placed: { description: 'Placed orders', input: {}, output: { kind: 'int' } } },
});
c.query('count_placed', async () => 0);
export default c;
