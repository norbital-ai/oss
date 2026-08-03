import { z } from 'zod';
import type { Hooks } from './$types.js';
import { photoSourceSchema } from '../../custom-types/photo_source/+definition.js';
import {
	inspectPhoto,
	matchPhotoFingerprints,
	type ExistingPhotoFingerprint
} from './lib/photo-integrity.js';
import { assertExactlyOnePhotoParent } from './lib/photo-parent.js';

const photoEvidenceCreateInput = z
	.object({
		job_assignment_id: z.string().uuid().nullable().optional(),
		variation_request_id: z.string().uuid().nullable().optional(),
		document_asset_id: z.string().uuid(),
		source: photoSourceSchema.optional()
	})
	.strict();

function sourceKey(source: z.infer<typeof photoSourceSchema>, assetId: string): string {
	return source.kind === 'channel'
		? `${source.provider}:${source.conversation_id}:${source.attachment_id}`
		: `workspace:${assetId}`;
}

export default {
	create: {
		input: photoEvidenceCreateInput,
		before: async ({ input, api }) => {
			const parsed = photoEvidenceCreateInput.parse(input);
			const jobAssignmentId = parsed.job_assignment_id;
			const variationRequestId = parsed.variation_request_id;
			assertExactlyOnePhotoParent(jobAssignmentId, variationRequestId);

			if (jobAssignmentId != null && jobAssignmentId !== '') {
				const row = await api.db.query.job_assignments.findFirst({
					where: { norbital_id: { eq: jobAssignmentId } }
				});
				if (row == null) throw new Error('Referenced job assignment does not exist.');
			} else if (variationRequestId != null && variationRequestId !== '') {
				const row = await api.db.query.variation_requests.findFirst({
					where: { norbital_id: { eq: variationRequestId } }
				});
				if (row == null) throw new Error('Referenced variation request does not exist.');
			}

			const asset = await api.readFileAsset(parsed.document_asset_id);
			if (asset.mimeType == null || !asset.mimeType.toLowerCase().startsWith('image/')) {
				throw new Error('Photo evidence requires an image file.');
			}
			const inspected = await inspectPhoto({ bytes: asset.bytes, mimeType: asset.mimeType });
			const source = parsed.source ?? { kind: 'workspace_upload' as const };

			return {
				job_assignment_id: parsed.job_assignment_id,
				variation_request_id: parsed.variation_request_id,
				document_asset_id: parsed.document_asset_id,
				source,
				source_key: sourceKey(source, asset.id),
				sha256: inspected.sha256,
				perceptual_hash: inspected.perceptualHash,
				flags: inspected.flags,
				matched_evidence_ids: []
			};
		},
		after: async ({ record, api }) => {
			const columns = { norbital_id: true, sha256: true, perceptual_hash: true } as const;
			const resultSets = await Promise.all([
				api.db.query.photo_evidence.findMany({
					where: { sha256: { eq: record.sha256 } },
					columns,
					limit: 21
				}),
				api.db.query.photo_evidence.findMany({
					where: { perceptual_hash: { eq: record.perceptual_hash } },
					columns,
					limit: 21
				})
			]);
			const existingById = new Map<string, ExistingPhotoFingerprint>();
			for (const candidate of resultSets.flat()) {
				if (candidate.norbital_id !== record.norbital_id) {
					existingById.set(candidate.norbital_id, candidate);
				}
			}
			const matches = matchPhotoFingerprints(record.sha256, record.perceptual_hash, [
				...existingById.values()
			]);
			await api.db.mutate('photo_evidence', [
				{
					norbital_id: record.norbital_id,
					flags: [...new Set([...(record.flags ?? []), ...matches.flags])],
					matched_evidence_ids: matches.matchedEvidenceIds
				}
			]);
		}
	},
	update: {
		before: async ({ input, existing, api }) => {
			const jobAssignmentId =
				input.job_assignment_id === undefined
					? existing.job_assignment_id
					: input.job_assignment_id;
			const variationRequestId =
				input.variation_request_id === undefined
					? existing.variation_request_id
					: input.variation_request_id;
			assertExactlyOnePhotoParent(jobAssignmentId, variationRequestId);

			if (jobAssignmentId != null && jobAssignmentId !== '') {
				const assignment = await api.db.query.job_assignments.findFirst({
					where: { norbital_id: { eq: jobAssignmentId } }
				});
				if (assignment == null) throw new Error('Referenced job assignment does not exist.');
			} else if (variationRequestId != null && variationRequestId !== '') {
				const variation = await api.db.query.variation_requests.findFirst({
					where: { norbital_id: { eq: variationRequestId } }
				});
				if (variation == null) throw new Error('Referenced variation request does not exist.');
			}

			return input;
		}
	}
} satisfies Hooks;
