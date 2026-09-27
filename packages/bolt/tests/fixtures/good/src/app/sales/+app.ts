import { app } from '../../../../../../src/index.ts';

export default app('sales', { title: 'Sales', description: 'Orders', icon: 'cart', pages: { board: { title: 'Board' }, list: { title: 'List' } } });
