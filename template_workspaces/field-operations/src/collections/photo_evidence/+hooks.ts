import { hexToBinaryEmbedding } from '@norbital-ai/pod/authoring';
import { z } from 'zod';
import type { Hooks } from './$types.js';
import { photoSourceSchema } from '../../custom-types/photo_source/+definition.js';
import { coordinatesOf, type LocationLike } from '../../lib/haversine.js';
import {
	assertExactlyOnePhotoParent,
	evaluateCaptureGeolocation,
	inspectPhoto,
	photoIntegrityFlags,
	suspectPhotoFlags,
	VISUAL_DUPLICATE_MAX_L2,
	type PhotoIntegrityFlag
} from './lib/photo-integrity.js';

const photoEvidenceCreateInput = z
	.object({
		job_assignment_id: z.string().uuid().nullable().optional(),
		variation_request_id: z.string().uuid().nullable().optional(),
		document_asset_id: z.string().uuid(),
		source: photoSourceSchema.optional()
	})
	.strict();

type PhotoCreateBefore = NonNullable<NonNullable<Hooks['create']>['before']>;
type PhotoCreateAfter = NonNullable<NonNullable<Hooks['create']>['after']>;
type PhotoBeforeApi = Parameters<PhotoCreateBefore>[0]['api'];
type PhotoAfterApi = Parameters<PhotoCreateAfter>[0]['api'];

function sourceKey(source: z.infer<typeof photoSourceSchema>, assetId: string): string {
	return source.kind === 'channel'
		? `${source.provider}:${source.conversation_id}:${source.attachment_id}`
		: `workspace:${assetId}`;
}

async function resolveSiteLocation(
	api: PhotoBeforeApi,
	jobAssignmentId: string | null | undefined,
	variationRequestId: string | null | undefined
): Promise<LocationLike> {
	let assignmentId = jobAssignmentId;
	if ((assignmentId == null || assignmentId === '') && variationRequestId != null) {
		const variation = await api.db.query.variation_requests.findFirst({
			where: { norbital_id: { eq: variationRequestId } },
			columns: { job_assignment_id: true }
		});
		assignmentId = variation?.job_assignment_id ?? null;
	}
	if (assignmentId == null || assignmentId === '') return null;

	const assignment = await api.db.query.job_assignments.findFirst({
		where: { norbital_id: { eq: assignmentId } },
		columns: { job_id: true }
	});
	if (assignment?.job_id == null) return null;

	const job = await api.db.query.jobs.findFirst({
		where: { norbital_id: { eq: assignment.job_id } },
		columns: { site_id: true }
	});
	if (job?.site_id == null) return null;

	const site = await api.db.query.sites.findFirst({
		where: { norbital_id: { eq: job.site_id } },
		columns: { location: true }
	});
	return site?.location ?? null;
}

async function markAssignmentSuspect(
	api: PhotoAfterApi,
	jobAssignmentId: string | null | undefined,
	variationRequestId: string | null | undefined
): Promise<void> {
	let assignmentId = jobAssignmentId;
	if ((assignmentId == null || assignmentId === '') && variationRequestId != null) {
		const variation = await api.db.query.variation_requests.findFirst({
			where: { norbital_id: { eq: variationRequestId } },
			columns: { job_assignment_id: true }
		});
		assignmentId = variation?.job_assignment_id ?? null;
	}
	if (assignmentId == null || assignmentId === '') return;

	const assignment = await api.db.query.job_assignments.findFirst({
		where: { norbital_id: { eq: assignmentId } },
		columns: { status: true }
	});
	if (assignment?.status === 'suspect') return;

	await api.db.mutate('job_assignments', [{ norbital_id: assignmentId, status: 'suspect' }]);
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
			const siteLocation = await resolveSiteLocation(api, jobAssignmentId, variationRequestId);
			const geoFlags = evaluateCaptureGeolocation(
				inspected.captureLocation,
				coordinatesOf(siteLocation)
			);
			const source = parsed.source ?? { kind: 'workspace_upload' as const };

			return {
				job_assignment_id: parsed.job_assignment_id,
				variation_request_id: parsed.variation_request_id,
				document_asset_id: parsed.document_asset_id,
				source,
				source_key: sourceKey(source, asset.id),
				sha256: inspected.sha256,
				perceptual_embedding: hexToBinaryEmbedding(inspected.perceptualHash),
				flags: [...new Set([...inspected.flags, ...geoFlags])],
				matched_evidence_ids: []
			};
		},
		after: async ({ record, api }) => {
			const columns = { norbital_id: true, sha256: true } as const;
			const visualMatchesPromise =
				record.perceptual_embedding == null
					? Promise.resolve([])
					: api.db.query.photo_evidence.findNearest({
							column: 'perceptual_embedding',
							probe: record.perceptual_embedding,
							metric: 'l2',
							maxDistance: VISUAL_DUPLICATE_MAX_L2,
							limit: 50,
							excludeIds: [record.norbital_id]
						});
			const [exactMatches, visualMatches] = await Promise.all([
				api.db.query.photo_evidence.findMany({
					where: { sha256: { eq: record.sha256 } },
					columns,
					limit: 21
				}),
				visualMatchesPromise
			]);

			const flags = new Set<PhotoIntegrityFlag>(
				(record.flags ?? []).filter(
					(flag): flag is PhotoIntegrityFlag =>
						typeof flag === 'string' && photoIntegrityFlags.includes(flag as PhotoIntegrityFlag)
				)
			);
			const matchedIds = new Set<string>();

			for (const candidate of exactMatches) {
				if (candidate.norbital_id === record.norbital_id) continue;
				flags.add('exact_duplicate');
				matchedIds.add(candidate.norbital_id);
			}

			for (const candidate of visualMatches) {
				if (candidate.norbital_id === record.norbital_id) continue;
				if (candidate.sha256 === record.sha256) continue;
				flags.add('visual_duplicate');
				matchedIds.add(candidate.norbital_id);
			}

			const mergedFlags = [...flags] as PhotoIntegrityFlag[];
			await api.db.mutate('photo_evidence', [
				{
					norbital_id: record.norbital_id,
					flags: mergedFlags,
					matched_evidence_ids: [...matchedIds]
				}
			]);

			if (!suspectPhotoFlags.some((flag) => mergedFlags.includes(flag))) return;
			await markAssignmentSuspect(api, record.job_assignment_id, record.variation_request_id);
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
