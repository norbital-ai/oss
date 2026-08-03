import type { Pipelines } from './$types.js';

export default {
	export: {
		handler: async ({ records }, api) => {
			const siteIds = records.map((site) => site.norbital_id);
			if (siteIds.length === 0) return [];

			const jobs = await api.db.query.jobs.findMany({
				where: { site_id: { in: siteIds } },
				limit: 1_000
			});
			const jobIds = jobs.map((job) => job.norbital_id);
			const certificationRequirements =
				jobIds.length > 0
					? await api.db.query.job_certification_requirements.findMany({
							where: { job_id: { in: jobIds } },
							limit: 5_000
						})
					: [];
			const certificationTypeIds = [
				...new Set(certificationRequirements.map((row) => row.certification_type_id))
			];
			const certificationTypes =
				certificationTypeIds.length > 0
					? await api.db.query.certification_types.findMany({
							where: { norbital_id: { in: certificationTypeIds } },
							limit: 1_000
						})
					: [];
			const certificationTypeById = new Map(
				certificationTypes.map((certification) => [certification.norbital_id, certification])
			);
			const certificationTypeIdsByJob = new Map<string, string[]>();
			for (const requirement of certificationRequirements) {
				const ids = certificationTypeIdsByJob.get(requirement.job_id) ?? [];
				ids.push(requirement.certification_type_id);
				certificationTypeIdsByJob.set(requirement.job_id, ids);
			}
			const assignments =
				jobIds.length > 0
					? await api.db.query.job_assignments.findMany({
							where: { job_id: { in: jobIds } },
							limit: 5_000
						})
					: [];
			const assignmentIds = assignments.map((assignment) => assignment.norbital_id);
			const variations =
				assignmentIds.length > 0
					? await api.db.query.variation_requests.findMany({
							where: { job_assignment_id: { in: assignmentIds } },
							limit: 5_000
						})
					: [];
			const variationIds = variations.map((variation) => variation.norbital_id);
			const evidence =
				assignmentIds.length > 0 || variationIds.length > 0
					? await api.db.query.photo_evidence.findMany({
							where: {
								OR: [
									...(assignmentIds.length > 0
										? [{ job_assignment_id: { in: assignmentIds } }]
										: []),
									...(variationIds.length > 0
										? [{ variation_request_id: { in: variationIds } }]
										: [])
								]
							},
							limit: 10_000
						})
					: [];

			return records.map((site) => {
				const siteJobs = jobs.filter((job) => job.site_id === site.norbital_id);
				const siteJobIds = new Set(siteJobs.map((job) => job.norbital_id));
				const siteAssignments = assignments.filter((assignment) =>
					siteJobIds.has(assignment.job_id)
				);
				const siteAssignmentIds = new Set(
					siteAssignments.map((assignment) => assignment.norbital_id)
				);
				const siteVariations = variations.filter((variation) =>
					siteAssignmentIds.has(variation.job_assignment_id)
				);
				const siteVariationIds = new Set(siteVariations.map((variation) => variation.norbital_id));
				const siteEvidence = evidence.filter(
					(photo) =>
						(photo.job_assignment_id != null && siteAssignmentIds.has(photo.job_assignment_id)) ||
						(photo.variation_request_id != null && siteVariationIds.has(photo.variation_request_id))
				);
				const code = (site.name || site.norbital_id).replace(/[^a-z0-9_-]/gi, '_');

				const jobRows = siteJobs.map((job) => ({
					record_id: job.norbital_id,
					site_id: job.site_id,
					title: job.title,
					nature: job.nature,
					required_certifications: (certificationTypeIdsByJob.get(job.norbital_id) ?? [])
						.map((certificationId) => certificationTypeById.get(certificationId))
						.filter((certification) => certification != null)
						.map((certification) => ({
							id: certification.norbital_id,
							code: certification.code,
							name: certification.name
						})),
					scheduled_for: job.scheduled_for,
					status: job.status,
					description: job.description
				}));
				const assignmentRows = siteAssignments.map((assignment) => ({
					record_id: assignment.norbital_id,
					job_id: assignment.job_id,
					contractor_profile_id: assignment.contractor_profile_id,
					dispatched_at: assignment.dispatched_at,
					status: assignment.status,
					completed_at: assignment.completed_at,
					amount_charged: assignment.amount_charged,
					summary: assignment.summary,
					location: assignment.location
				}));
				const variationRows = siteVariations.map((variation) => ({
					record_id: variation.norbital_id,
					job_assignment_id: variation.job_assignment_id,
					requested_at: variation.requested_at,
					title: variation.title,
					description: variation.description,
					amount: variation.amount,
					approval_request_id: variation.norbital_approval_id
				}));
				const evidenceRows = siteEvidence.map((photo) => ({
					record_id: photo.norbital_id,
					job_assignment_id: photo.job_assignment_id,
					variation_request_id: photo.variation_request_id,
					document_asset_id: photo.document_asset_id,
					sha256: photo.sha256,
					flags: photo.flags,
					matched_evidence_ids: photo.matched_evidence_ids
				}));

				return {
					label: `Field operations interoperability bundle · ${site.name}`,
					attachments: [
						{
							name: `field_ops_${code}.json`,
							contentType: 'JSON' as const,
							content: {
								schema: 'norbital.field_operations.interoperability.v1',
								site,
								jobs: jobRows,
								job_assignments: assignmentRows,
								variation_requests: variationRows,
								photo_evidence: evidenceRows
							}
						},
						{
							name: `field_ops_${code}_jobs.csv`,
							contentType: 'CSV' as const,
							content: jobRows.map((job) => ({
								...job,
								required_certifications: JSON.stringify(job.required_certifications)
							}))
						},
						{
							name: `field_ops_${code}_job_assignments.csv`,
							contentType: 'CSV' as const,
							content: assignmentRows.map((assignment) => ({
								...assignment,
								location: JSON.stringify(assignment.location)
							}))
						},
						{
							name: `field_ops_${code}_variations.csv`,
							contentType: 'CSV' as const,
							content: variationRows
						},
						{
							name: `field_ops_${code}_photo_evidence.csv`,
							contentType: 'CSV' as const,
							content: evidenceRows.map((photo) => ({
								...photo,
								flags: (photo.flags ?? []).join('|'),
								matched_evidence_ids: (photo.matched_evidence_ids ?? []).join('|')
							}))
						}
					],
					metadata: {
						schema: 'norbital.field_operations.interoperability.v1',
						site_id: site.norbital_id
					}
				};
			});
		}
	}
} satisfies Pipelines;
