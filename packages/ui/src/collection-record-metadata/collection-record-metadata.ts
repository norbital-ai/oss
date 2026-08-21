export type CollectionRecordMutation = 'update' | 'delete';

export type CollectionRecordFlagTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export interface CollectionRecordRestrictionMetadata {
	readonly kind: 'restriction';
	/** The mutations this record refuses. Reading, opening, selecting, and exporting remain available. */
	readonly operations: readonly [CollectionRecordMutation, ...CollectionRecordMutation[]];
	/** Concise operator-facing explanation of the rule. */
	readonly reason: string;
	/** Optional short label; surfaces otherwise use their standard read-only label. */
	readonly label?: string;
}

export interface CollectionRecordFlagMetadata {
	readonly kind: 'flag';
	readonly tone: CollectionRecordFlagTone;
	readonly label: string;
	readonly description?: string;
	/** Iconify icon name. Omit to use the tone's standard icon. */
	readonly icon?: string;
}

/**
 * Metadata an application may attach to a record surface.
 *
 * This is deliberately a discriminated union rather than an open property bag. Adding another
 * behaviour means adding another explicit variant and teaching every generic collection surface
 * what it means. Data that has no generic behaviour belongs in the authored card/representation.
 */
export type CollectionRecordMetadata =
	CollectionRecordRestrictionMetadata | CollectionRecordFlagMetadata;

/**
 * Pure, synchronous projection over an already-read row. Related facts must be batch-loaded by the
 * surface before this runs; a resolver is never a place to issue one query per record.
 */
export type CollectionRecordMetadataResolver<TRow extends object> = (
	record: TRow
) => readonly CollectionRecordMetadata[];

export type CollectionRecordMetadataSource = 'system' | 'application';

export type ResolvedCollectionRecordMetadata = (
	CollectionRecordRestrictionMetadata | CollectionRecordFlagMetadata
) & { readonly source: CollectionRecordMetadataSource };

export interface CollectionRecordSystemMetadataCopy {
	readonly pendingApprovalLabel: string;
	readonly pendingApprovalReason: string;
}

/**
 * Projects protected Bolt state and authored metadata into the one contract collection UIs consume.
 * Authored metadata never accepts a `source`, so an application cannot impersonate system state.
 */
export function resolveCollectionRecordMetadata(
	record: object | null | undefined,
	authored: readonly CollectionRecordMetadata[] | null | undefined,
	copy: CollectionRecordSystemMetadataCopy
): readonly ResolvedCollectionRecordMetadata[] {
	const resolved: ResolvedCollectionRecordMetadata[] = [];

	const approvalId = record == null ? undefined : Reflect.get(record, 'norbital_approval_id');
	if (typeof approvalId === 'string' && approvalId.length > 0) {
		resolved.push({
			kind: 'restriction',
			source: 'system',
			operations: ['update', 'delete'],
			label: copy.pendingApprovalLabel,
			reason: copy.pendingApprovalReason
		});
	}

	for (const metadata of authored ?? []) {
		resolved.push({ ...metadata, source: 'application' });
	}

	return resolved;
}

export function collectionRecordRestriction(
	metadata: readonly ResolvedCollectionRecordMetadata[],
	operation: CollectionRecordMutation
): Extract<ResolvedCollectionRecordMetadata, { readonly kind: 'restriction' }> | null {
	return (
		metadata.find(
			(
				entry
			): entry is Extract<ResolvedCollectionRecordMetadata, { readonly kind: 'restriction' }> =>
				entry.kind === 'restriction' && entry.operations.includes(operation)
		) ?? null
	);
}

export function collectionRecordMutationReason(
	metadata: readonly ResolvedCollectionRecordMetadata[],
	operation: CollectionRecordMutation
): string | null {
	return collectionRecordRestriction(metadata, operation)?.reason ?? null;
}

export function collectionRecordMetadataDescription(
	metadata: ResolvedCollectionRecordMetadata
): string {
	return metadata.kind === 'restriction'
		? metadata.reason
		: (metadata.description ?? metadata.label);
}
