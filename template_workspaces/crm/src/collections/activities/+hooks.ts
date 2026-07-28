import type { Hooks } from './$types.js';

export default {
	create: {
		before: async ({ input }) => {
			if (input.type === 'task' && input.due_date == null) {
				return { ...input, due_date: new Date().toISOString().split('T')[0] };
			}
			return input;
		}
	}
} satisfies Hooks;
