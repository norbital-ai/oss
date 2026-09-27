import { relationship } from '../../../src/index.ts';

export default relationship({
	'orders.customer': { to: 'customers', inverse: 'orders' },
	'orders.owner': { to: 'sys_user', optional: true, default: { actor: 'id' } },
	'order_lines.order': { to: 'orders', inverse: 'lines', owned: true },
	'notice_notes.notice': { to: 'notices', inverse: 'notes', owned: true },
	'sites.customer': { to: 'customers', optional: true, onDelete: 'setNull', inverse: 'sites', where: { tier: { eq: 'gold' } } },
});
