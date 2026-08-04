import type { Hooks } from './$types.js';
import {
	contractorSatisfiesCertificationRequirements,
	missingCertificationIds
} from '../../lib/certification-eligibility.js';

type AssignmentIdentity = {
	job_id?: string | null;
	contractor_profile_id?: string | null;
};

type AssignmentStatus = 'dispatched' | 'in_progress' | 'completed' | 'flagged';

type LocationLike =
	| {
			geometry?: { lat?: number | null; lon?: number | null } | null;
	  }
	| null
	| undefined;

function requireId(value: string | null | undefined, message: string): string {
	if (!value) throw new Error(message);
	return value;
}

function requireFound<T>(value: T, message: string): NonNullable<T> {
	if (value == null) throw new Error(message);
	return value;
}

function assertAbsent(value: unknown, message: string): void {
	if (value != null) throw new Error(message);
}

function assignmentStatus(value: string | null | undefined): AssignmentStatus {
	switch (value) {
		case 'dispatched':
		case 'in_progress':
		case 'completed':
		case 'flagged':
			return value;
		case undefined:
		case null:
			return 'dispatched';
		default:
			throw new Error(`Unsupported assignment status: ${value}.`);
	}
}

export function assignmentStatusForLocation(
	status: AssignmentStatus,
	assignmentLocation: LocationLike,
	siteLocation: LocationLike
): AssignmentStatus {
	const distanceM = haversineMeters(
		assignmentLocation?.geometry?.lat,
		assignmentLocation?.geometry?.lon,
		siteLocation?.geometry?.lat,
		siteLocation?.geometry?.lon
	);
	return distanceM != null && distanceM > 500 ? 'flagged' : status;
}

export function assertAssignmentIdentityUnchanged(
	input: AssignmentIdentity,
	existing: Required<AssignmentIdentity>
): void {
	if (input.job_id != null && input.job_id !== existing.job_id) {
		throw new Error('A dispatched assignment cannot be moved to another job.');
	}
	if (
		input.contractor_profile_id != null &&
		input.contractor_profile_id !== existing.contractor_profile_id
	) {
		throw new Error('A dispatched assignment cannot be moved to another contractor.');
	}
}

export default {
	create: {
		before: async ({ input, api }) => {
			const jobId = requireId(input.job_id, 'Job assignment must reference a job.');
			const contractorId = requireId(
				input.contractor_profile_id,
				'Job assignment must reference a contractor profile.'
			);

			const [foundJob, foundContractor, existingAssignment, existingSource] = await Promise.all([
				api.db.query.jobs.findFirst({
					where: { norbital_id: { eq: jobId } }
				}),
				api.db.query.contractor_profiles.findFirst({
					where: { norbital_id: { eq: contractorId } }
				}),
				api.db.query.job_assignments.findFirst({
					where: { job_id: { eq: jobId } }
				}),
				input.source_message_id != null && input.source_message_id !== ''
					? api.db.query.job_assignments.findFirst({
							where: { source_message_id: { eq: input.source_message_id } }
						})
					: Promise.resolve(undefined)
			]);

			const job = requireFound(foundJob, 'Referenced job does not exist.');
			requireFound(foundContractor, 'Referenced contractor profile does not exist.');
			assertAbsent(existingAssignment, 'This job already has an assignment.');
			assertAbsent(existingSource, 'A job assignment with this source_message_id already exists.');
			const [requirements, holdings] = await Promise.all([
				api.db.query.job_certification_requirements.findMany({
					where: { job_id: { eq: jobId } },
					limit: 250
				}),
				api.db.query.contractor_certifications.findMany({
					where: { contractor_profile_id: { eq: contractorId } },
					limit: 250
				})
			]);
			if (!contractorSatisfiesCertificationRequirements(holdings, requirements)) {
				const missingIds = missingCertificationIds(holdings, requirements);
				const missingTypes = await api.db.query.certification_types.findMany({
					where: { norbital_id: { in: missingIds } },
					columns: { norbital_id: true, name: true },
					limit: missingIds.length
				});
				const missingNames = new Map(
					missingTypes.map((certification) => [certification.norbital_id, certification.name])
				);
				throw new Error(
					`Contractor is missing required certifications: ${missingIds
						.map((certificationId) => missingNames.get(certificationId) ?? '—')
						.join(', ')}.`
				);
			}

			const site =
				input.location == null
					? undefined
					: await api.db.query.sites.findFirst({
							where: { norbital_id: { eq: job.site_id } }
						});
			const status = assignmentStatusForLocation(
				assignmentStatus(input.status),
				input.location,
				site?.location
			);

			return {
				...input,
				dispatched_at: input.dispatched_at ?? new Date(),
				status
			};
		},
		after: async ({ record, api }) => {
			const job = await api.db.query.jobs.findFirst({
				where: { norbital_id: { eq: record.job_id } }
			});
			if (job?.status === 'unassigned') {
				await api.db.mutate('jobs', [{ norbital_id: record.job_id, status: 'assigned' }]);
			}
		}
	},
	update: {
		before: async ({ input, existing, api }) => {
			assertAssignmentIdentityUnchanged(input, existing);
			const withCompletion =
				input.status === 'completed' && input.completed_at == null
					? { ...input, completed_at: new Date() }
					: input;
			const jobId = input.job_id ?? existing.job_id;
			const location = input.location ?? existing.location;
			if (location == null || jobId == null) return withCompletion;

			const job = await api.db.query.jobs.findFirst({
				where: { norbital_id: { eq: jobId } }
			});
			if (job == null) return withCompletion;

			const site = await api.db.query.sites.findFirst({
				where: { norbital_id: { eq: job.site_id } }
			});
			if (site?.location == null) return withCompletion;

			const distanceM = haversineMeters(
				location.geometry?.lat,
				location.geometry?.lon,
				site.location.geometry?.lat,
				site.location.geometry?.lon
			);
			if (distanceM != null && distanceM > 500) {
				return { ...withCompletion, status: 'flagged' };
			}
			return withCompletion;
		},
		after: async ({ record, api }) => {
			const status = record.status;
			if (status == null) return;
			const jobStatus = mapAssignmentStatusToJobStatus(
				status as 'dispatched' | 'in_progress' | 'completed' | 'flagged'
			);
			await api.db.mutate('jobs', [{ norbital_id: record.job_id, status: jobStatus }]);
		}
	}
} satisfies Hooks;

export function mapAssignmentStatusToJobStatus(
	status: 'dispatched' | 'in_progress' | 'completed' | 'flagged'
): 'assigned' | 'in_progress' | 'completed' {
	switch (status) {
		case 'completed':
			return 'completed';
		case 'in_progress':
			return 'in_progress';
		case 'flagged':
		case 'dispatched':
			return 'assigned';
		default: {
			const _exhaustive: never = status;
			return _exhaustive;
		}
	}
}

function haversineMeters(
	lat1: number | null | undefined,
	lon1: number | null | undefined,
	lat2: number | null | undefined,
	lon2: number | null | undefined
): number | null {
	if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return null;
	const R = 6371000;
	const toRad = (deg: number) => (deg * Math.PI) / 180;
	const dLat = toRad(lat2 - lat1);
	const dLon = toRad(lon2 - lon1);
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
	return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}
