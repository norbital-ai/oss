import { relationship } from '../../../src/index.ts';

export default relationship({
	'orders.customer': { to: 'customers', inverse: 'orders' },
	'orders.owner': { to: 'sys_user', optional: true, default: { actor: 'id' } },
	'order_lines.order': { to: 'orders', inverse: 'lines', owned: true },
	'notice_notes.notice': { to: 'notices', inverse: 'notes', owned: true },
	'sites.customer': {
		to: 'customers',
		optional: true,
		onDelete: 'setNull',
		inverse: 'sites',
		where: { tier: { eq: 'gold' } }
	},
	'customers.hotline': {
		to: 'sys_integration',
		optional: true,
		where: { integration: { eq: 'whatsapp' } }
	},
	'orders.ledger': {
		to: 'sys_integration',
		optional: true,
		where: { integration: { eq: 'kingdee' } }
	},
	'notices.inbox': { to: 'sys_integration', where: { integration: { eq: 'support_mail' } } },
	'products.source': { to: 'sys_integration', where: { integration: { eq: 'kingdee' } } },
	'entries.account': { to: 'sys_integration', where: { integration: { eq: 'calendar' } } },
	'notice_notes.integration': { to: 'sys_integration', optional: true }
});
