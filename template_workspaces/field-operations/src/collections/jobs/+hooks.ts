import type { Hooks } from './$types.js';

export default {
	create: {
		before: {
			description:
				'Refuses a job that names no site or a site that does not exist, and files a new job as unassigned until a contractor is dispatched.',
			handler: async ({ input, api }) => {
				if (input.site_id == null || input.site_id === '') {
					throw new Error('Job must reference a site.');
				}

				const site = await api.db.query.sites.findFirst({
					where: { norbital_id: { eq: input.site_id } }
				});
				if (site == null) {
					throw new Error('Referenced site does not exist.');
				}

				return {
					...input,
					status: input.status ?? 'unassigned'
				};
			}
		}
	}
} satisfies Hooks;
