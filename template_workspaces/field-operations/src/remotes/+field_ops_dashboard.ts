import { defineQueryHandler } from '@norbital-ai/pod/authoring';
import { z } from 'zod';

function monthBounds(scheduledFor: string): { start: string; end: string } {
	const monthPrefix = scheduledFor.slice(0, 7);
	const [yearText, monthText] = monthPrefix.split('-');
	const year = Number(yearText);
	const month = Number(monthText);
	const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
	return {
		start: `${monthPrefix}-01`,
		end: `${monthPrefix}-${String(lastDay).padStart(2, '0')}`
	};
}

export default defineQueryHandler({
	schema: z.object({ scheduled_for: z.iso.date() }),
	handler: async ({ scheduled_for }, api) => {
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
		const month = monthBounds(scheduled_for);
		const monthJobs = await api.db.query.jobs.findMany({
			where: {
				scheduled_for: { gte: month.start, lte: month.end }
			},
			columns: { norbital_id: true, title: true },
			limit: 1000
		});
		const monthJobById = new Map(monthJobs.map((job) => [job.norbital_id, job.title]));
		const monthSuspectAssignments =
			monthJobById.size === 0
				? []
				: await api.db.query.job_assignments.findMany({
						where: {
							job_id: { in: [...monthJobById.keys()] },
							status: { eq: 'suspect' }
						},
						columns: { norbital_id: true, job_id: true },
						limit: 1000
					});
		const month_suspects = monthSuspectAssignments.flatMap((assignment) => {
			const title = monthJobById.get(assignment.job_id);
			return title ? [{ id: assignment.norbital_id, job: title }] : [];
		});

		if (jobs.length === 0) {
			return { assignment_cards: [], assignment_ids: [], map_points: [], month_suspects };
		}

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
		if (assignments.length === 0) {
			return { assignment_cards: [], assignment_ids: [], map_points: [], month_suspects };
		}

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
			month_suspects,
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
