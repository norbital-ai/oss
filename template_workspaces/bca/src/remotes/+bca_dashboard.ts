import { defineQueryHandler } from '@norbital-ai/pod/authoring';
import { z } from 'zod';
import type { Api } from './$types.js';

export default defineQueryHandler({
	schema: z.object({ scheduled_for: z.iso.date() }),
	handler: async ({ scheduled_for }, api: Api) => {
		const jobs = await api.db.query.jobs.findMany({
			where: { scheduled_for: { eq: scheduled_for } },
			columns: {
				norbital_id: true,
				site_id: true,
				title: true,
				status: true
			},
			orderBy: { title: 'asc' },
			limit: 1000
		});
		if (jobs.length === 0) return { assignment_cards: [], assignment_ids: [], map_points: [] };

		const assignments = await api.db.query.job_assignments.findMany({
			where: { job_id: { in: jobs.map((job) => job.norbital_id) } },
			columns: {
				norbital_id: true,
				job_id: true,
				contractor_profile_id: true,
				status: true
			},
			limit: 1000
		});
		if (assignments.length === 0)
			return { assignment_cards: [], assignment_ids: [], map_points: [] };

		const jobById = new Map(jobs.map((job) => [job.norbital_id, job]));
		const contractorIds = [
			...new Set(assignments.map((assignment) => assignment.contractor_profile_id))
		];
		const siteIds = [
			...new Set(
				assignments.flatMap((assignment) => {
					const job = jobById.get(assignment.job_id);
					return job ? [job.site_id] : [];
				})
			)
		];
		const [contractors, sites] = await Promise.all([
			api.db.query.contractor_profiles.findMany({
				where: { norbital_id: { in: contractorIds } },
				columns: { norbital_id: true, company_name: true },
				limit: contractorIds.length
			}),
			api.db.query.sites.findMany({
				where: { norbital_id: { in: siteIds } },
				columns: { norbital_id: true, name: true, location: true },
				limit: siteIds.length
			})
		]);
		const contractorById = new Map(
			contractors.map((contractor) => [contractor.norbital_id, contractor.company_name])
		);
		const assignmentsBySite = new Map<
			string,
			Array<{ id: string; job: string; contractor: string; status: string }>
		>();

		for (const assignment of assignments) {
			const job = jobById.get(assignment.job_id);
			if (!job) continue;
			const siteAssignments = assignmentsBySite.get(job.site_id) ?? [];
			siteAssignments.push({
				id: assignment.norbital_id,
				job: job.title,
				contractor: contractorById.get(assignment.contractor_profile_id) ?? 'Unknown contractor',
				status: assignment.status ?? 'dispatched'
			});
			assignmentsBySite.set(job.site_id, siteAssignments);
		}

		return {
			assignment_ids: assignments.map((assignment) => assignment.norbital_id),
			assignment_cards: assignments.flatMap((assignment) => {
				const job = jobById.get(assignment.job_id);
				return job
					? [
							{
								id: assignment.norbital_id,
								job: job.title,
								contractor:
									contractorById.get(assignment.contractor_profile_id) ?? 'Unknown contractor'
							}
						]
					: [];
			}),
			map_points: sites.flatMap((site) => {
				const siteAssignments = assignmentsBySite.get(site.norbital_id) ?? [];
				const geometry = site.location?.geometry;
				if (!geometry || siteAssignments.length === 0) return [];
				return [
					{
						id: site.norbital_id,
						name: site.name,
						label: site.location?.formatted_address ?? site.name,
						latitude: geometry.lat,
						longitude: geometry.lon,
						assignments: siteAssignments
					}
				];
			})
		};
	}
});
