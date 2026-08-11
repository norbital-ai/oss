import { deskToday } from '../../lib/calendar.js';
import type { Hooks } from './$types.js';

export default {
	create: {
		before: {
			description:
				'Stamps a task activity with the current desk date as its due date when none was entered.',
			handler: async ({ input }) => {
				if (input.type === 'task' && input.due_date == null) {
					return { ...input, due_date: deskToday() };
				}
				return input;
			}
		}
	}
} satisfies Hooks;
