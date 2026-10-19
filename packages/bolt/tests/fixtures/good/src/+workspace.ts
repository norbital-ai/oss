export default {
	tz: 'Asia/Singapore',
	locale: 'en-SG',
	currency: 'SGD',
	apps: ['sales', 'hr/kiosk'],
	connections: { erp: { integration: 'erp' }, support: { integration: 'mail', envoy: 'desk' } }
} as const;
