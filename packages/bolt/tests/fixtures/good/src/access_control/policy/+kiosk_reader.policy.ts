export default {
	description: 'Read the order summary on the kiosk.',
	grants: { orders: { outputs: { default: true } } }
} as const;
