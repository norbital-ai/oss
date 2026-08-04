import { deskToday } from '../../lib/calendar.js';
import type { Hooks } from './$types.js';

export default {
	create: {
		before: async ({ input }) => {
			if (input.type === 'task' && input.due_date == null) {
				return { ...input, due_date: deskToday() };
			}
			return input;
		}
	}
} satisfies Hooks;
