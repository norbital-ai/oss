import type { Hooks } from './$types.js';

const ASSIGNMENT_ERROR =
	'Worker must satisfy at least one site-location job requirement with all required active certifications before assignment.';

type CreateBefore = NonNullable<NonNullable<Hooks['create']>['before']>;
type HookApi = Parameters<CreateBefore>[0]['api'];
type ComplianceInput = {
	readonly site_location_id: string | null | undefined;
	readonly worker_id: string | null | undefined;
};

export default {
	create: {
		before: async ({ input, api }) => {
			await validateJobAssignmentCompliance(
				{ site_location_id: input.site_location_id, worker_id: input.worker_id },
				api
			);
			return input;
		}
	},
	update: {
		before: async ({ input, existing, api }) => {
			const record = { ...existing, ...input };
			await validateJobAssignmentCompliance(
				{ site_location_id: record.site_location_id, worker_id: record.worker_id },
				api
			);
			return input;
		}
	}
} satisfies Hooks;

async function validateJobAssignmentCompliance(
	incoming: ComplianceInput,
	api: HookApi
): Promise<void> {
	const siteLocationId = incoming.site_location_id;
	const workerId = incoming.worker_id;
	if (!siteLocationId || !workerId) {
		throw new Error(ASSIGNMENT_ERROR);
	}

	const now = new Date().toISOString();
	const workerPermitLinks = await api.db.query.permits_to_work_workers.findMany({
		where: { worker_id: { eq: workerId } },
		limit: 250
	});
	const permitIds = [...new Set(workerPermitLinks.map((link) => link.permits_to_work_id))];
	const permits =
		permitIds.length === 0
			? []
			: await api.db.query.permits_to_work.findMany({
					where: { norbital_id: { in: permitIds } },
					limit: 250
				});
	const permitCertificationLinks =
		permitIds.length === 0
			? []
			: await api.db.query.permits_to_work_certification_types.findMany({
					where: { permits_to_work_id: { in: permitIds } },
					limit: 250
				});
	const certificationIdsByPermit = new Map<string, string[]>();
	for (const link of permitCertificationLinks) {
		const ids = certificationIdsByPermit.get(link.permits_to_work_id) ?? [];
		ids.push(link.certification_type_id);
		certificationIdsByPermit.set(link.permits_to_work_id, ids);
	}

	const coveredCertificationIds = new Set<string>();
	for (const permit of permits) {
		if (permit.status !== 'active') continue;
		if (permit.validity_range?.start != null && permit.validity_range.start > now) continue;
		if (permit.validity_range?.end != null && permit.validity_range.end < now) continue;
		for (const certificationId of certificationIdsByPermit.get(permit.norbital_id) ?? []) {
			coveredCertificationIds.add(certificationId);
		}
	}

	const siteJobLinks = await api.db.query.jobs_site_locations.findMany({
		where: { site_location_id: { eq: siteLocationId } },
		limit: 250
	});
	const jobIds = [...new Set(siteJobLinks.map((link) => link.job_id))];
	const jobCertificationLinks =
		jobIds.length === 0
			? []
			: await api.db.query.jobs_certification_types.findMany({
					where: { job_id: { in: jobIds } },
					limit: 250
				});

	if (jobIds.length === 0) {
		throw new Error(ASSIGNMENT_ERROR);
	}
	const certificationIdsByJob = new Map<string, string[]>();
	for (const link of jobCertificationLinks) {
		const ids = certificationIdsByJob.get(link.job_id) ?? [];
		ids.push(link.certification_type_id);
		certificationIdsByJob.set(link.job_id, ids);
	}

	const hasRequiredCertification = jobIds.some((jobId) => {
		const requiredCertificationIds = certificationIdsByJob.get(jobId) ?? [];
		if (requiredCertificationIds.length === 0) return false;
		return requiredCertificationIds.every((certificationId) =>
			coveredCertificationIds.has(certificationId)
		);
	});

	if (!hasRequiredCertification) {
		throw new Error(ASSIGNMENT_ERROR);
	}
}
