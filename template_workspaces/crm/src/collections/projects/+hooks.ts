import type { Hooks } from './$types.js';

export default {
	create: {
		before: async ({ input, api }) => {
			if (!input.account_id) throw new Error('A project must reference an account.');
			const account = await api.db.query.accounts.findFirst({
				where: { norbital_id: { eq: input.account_id } }
			});
			if (!account) throw new Error('Referenced account does not exist.');
			return { ...input, status: input.status ?? 'active' };
		}
	}
} satisfies Hooks;
