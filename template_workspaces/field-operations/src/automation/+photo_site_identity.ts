import { defineAutomation } from '@norbital-ai/pod/authoring';
import { z } from 'zod';

const FAST_VISION_MODEL = 'stepfun/step-3.7-flash';

const siteIdentitySchema = z
	.object({
		evidence_available: z.boolean(),
		site_name: z.string().nullable(),
		site_location: z.string().nullable(),
		unit_number: z.string().nullable(),
		confidence: z.enum(['low', 'medium', 'high'])
	})
	.strict();

function present(value: string | null): string | null {
	const trimmed = value?.trim() ?? '';
	return trimmed.length > 0 ? trimmed : null;
}

export default defineAutomation(
	{ trigger: { collection: 'photo_evidence', event: 'created' } },
	{
		description:
			'Reads a newly filed job-site photo with a vision model and, when a site name, location or unit number is plainly legible in the image, stamps it onto the linked job assignment and clears the unverified site-identity flag.',
		handler: async (api, { scope }) => {
			const evidence = scope.incoming_record;
			let assignmentId = evidence.job_assignment_id;
			if (assignmentId == null && evidence.variation_request_id != null) {
				const variation = await api.db.query.variation_requests.findFirst({
					where: { norbital_id: { eq: evidence.variation_request_id } },
					columns: { job_assignment_id: true }
				});
				assignmentId = variation?.job_assignment_id ?? null;
			}
			if (assignmentId == null) {
				return { status: 'skipped', reason: 'photo evidence has no resolvable job assignment' };
			}

			const assignment = await api.db.query.job_assignments.findFirst({
				where: { norbital_id: { eq: assignmentId } },
				columns: { norbital_id: true }
			});
			if (assignment == null) {
				return { status: 'skipped', reason: 'linked job assignment no longer exists' };
			}

			const checkedAt = new Date();
			try {
				const inferred = await api.infer({
					model: FAST_VISION_MODEL,
					schema: siteIdentitySchema,
					images: [{ assetId: evidence.document_asset_id, detail: 'high' }],
					prompt: [
						'Inspect only the attached job-site photo.',
						'Extract site identity that is visibly readable in the image: a site or building name,',
						'a street/block/location, and a unit/lot/door number.',
						'Do not infer from visual style, metadata, or unstated context.',
						'Set evidence_available true only when at least one extracted identifier is explicit and legible.',
						'Use null for every value that is absent or uncertain.'
					].join(' ')
				});

				const siteName = present(inferred.site_name);
				const siteLocation = present(inferred.site_location);
				const unitNumber = present(inferred.unit_number);
				const hasIdentifier = siteName != null || siteLocation != null || unitNumber != null;
				const available =
					inferred.evidence_available && hasIdentifier && inferred.confidence !== 'low';

				if (available) {
					await api.db.job_assignments.update(assignmentId, {
						site_identity_unverified: false,
						site_identity_evidence_id: evidence.norbital_id,
						extracted_site_name: siteName,
						extracted_site_location: siteLocation,
						extracted_unit_number: unitNumber,
						site_identity_confidence: inferred.confidence,
						site_identity_checked_at: checkedAt
					});
					return { status: 'available', model: FAST_VISION_MODEL, confidence: inferred.confidence };
				}

				// The assignment defaults to unverified. An inconclusive photo deliberately does not write:
				// that keeps the flag true for a new assignment without letting a later weak photo undo a
				// previous verified result.
				return { status: 'unavailable', model: FAST_VISION_MODEL };
			} catch (error) {
				return {
					status: 'failed',
					model: FAST_VISION_MODEL,
					error: error instanceof Error ? error.message : String(error)
				};
			}
		}
	}
);
