import { relationship } from '../../../../../src/index.ts';

export default relationship({
	'orders.customer': { to: 'customers', inverse: 'orders' },
	'notices.inbox': { to: 'sys_integration', where: { integration: { eq: 'mail' } } }
});
