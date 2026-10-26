export default {
	description: 'Read the order summary on the kiosk.',
	grants: { orders: { read: { fields: ['number', 'status'] } } }
} as const;
