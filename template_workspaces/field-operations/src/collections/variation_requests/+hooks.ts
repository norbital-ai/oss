import type { Hooks } from './$types.js';

export default {
	create: {
		before: {
			description:
				'Ties a scope change to an existing job assignment, rejects a second variation raised from the same source message, and stamps when it was requested.',
			handler: async ({ input, api }) => {
				if (input.job_assignment_id == null || input.job_assignment_id === '') {
					throw new Error('Variation request must reference a job assignment.');
				}

				const assignment = await api.db.query.job_assignments.findFirst({
					where: { norbital_id: { eq: input.job_assignment_id } }
				});
				if (assignment == null) {
					throw new Error('Referenced job assignment does not exist.');
				}

				if (input.source_message_id != null && input.source_message_id !== '') {
					const existing = await api.db.query.variation_requests.findFirst({
						where: { source_message_id: { eq: input.source_message_id } }
					});
					if (existing != null) {
						throw new Error('A variation request with this source_message_id already exists.');
					}
				}

				return {
					...input,
					requested_at: input.requested_at ?? new Date()
				};
			}
		}
	}
} satisfies Hooks;
