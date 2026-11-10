export default {
	description: 'Read sales orders.',
	grants: { orders: { outputs: { default: true } } }
} as const;
