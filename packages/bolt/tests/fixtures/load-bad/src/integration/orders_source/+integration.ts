export default {
	name: 'orders_feed',
	spec: {
		description: 'x',
		driver: 'sqlserver',
		feeds: { orders: { into: 'orders', key: ['number'], cron: '@hourly' } }
	},
	bodies: { feeds: {}, outbound: {} }
};
