export default {
	description: 'Read the order summary on the kiosk.',
	grants: { orders: { read: { orders: { fields: ['number', 'status'] } } } }
} as const;
