import { Schema } from 'effect';

const CollectionRecordMutationSchema = Schema.Literals(['update', 'delete']);
export type CollectionRecordMutation = typeof CollectionRecordMutationSchema.Type;

const CollectionRecordFlagToneSchema = Schema.Literals([
	'neutral',
	'info',
	'success',
	'warning',
	'danger'
]);
export type CollectionRecordFlagTone = typeof CollectionRecordFlagToneSchema.Type;

const CollectionRecordRestrictionMetadataSchema = Schema.Struct({
	kind: Schema.Literal('restriction'),
	/** The mutations this record refuses. Reading, opening, selecting, and exporting remain available. */
	operations: Schema.NonEmptyArray(CollectionRecordMutationSchema),
	/** Concise operator-facing explanation of the rule. */
	reason: Schema.String,
	/** Optional short label; surfaces otherwise use their standard read-only label. */
	label: Schema.optional(Schema.String)
});
export type CollectionRecordRestrictionMetadata =
	typeof CollectionRecordRestrictionMetadataSchema.Type;

const CollectionRecordFlagMetadataSchema = Schema.Struct({
	kind: Schema.Literal('flag'),
	tone: CollectionRecordFlagToneSchema,
	label: Schema.String,
	description: Schema.optional(Schema.String),
	/** Iconify icon name. Omit to use the tone's standard icon. */
	icon: Schema.optional(Schema.String)
});
export type CollectionRecordFlagMetadata = typeof CollectionRecordFlagMetadataSchema.Type;

/**
 * Metadata an application may attach to a record surface.
 *
 * This is deliberately a discriminated union rather than an open property bag. Adding another
 * behaviour means adding another explicit variant and teaching every generic collection surface
 * what it means. Data that has no generic behaviour belongs in the authored card/representation.
 */
const CollectionRecordMetadataSchema = Schema.Union([
	CollectionRecordRestrictionMetadataSchema,
	CollectionRecordFlagMetadataSchema
]);
export type CollectionRecordMetadata = typeof CollectionRecordMetadataSchema.Type;

/**
 * Pure, synchronous projection over an already-read row. Related facts must be batch-loaded by the
 * surface before this runs; a resolver is never a place to issue one query per record.
 */
export type CollectionRecordMetadataResolver<TRow extends object> = (
	record: TRow
) => readonly CollectionRecordMetadata[];

const CollectionRecordMetadataSourceSchema = Schema.Literals(['system', 'application']);
export type CollectionRecordMetadataSource = typeof CollectionRecordMetadataSourceSchema.Type;

export type ResolvedCollectionRecordMetadata = CollectionRecordMetadata & {
	readonly source: CollectionRecordMetadataSource;
};

const CollectionRecordSystemMetadataCopySchema = Schema.Struct({
	pendingApprovalLabel: Schema.String,
	pendingApprovalReason: Schema.String
});
export type CollectionRecordSystemMetadataCopy =
	typeof CollectionRecordSystemMetadataCopySchema.Type;

const isString = Schema.is(Schema.String);

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

	const approvalId = record == null ? undefined : Reflect.get(record, 'approval_id');
	if (isString(approvalId) && approvalId.length > 0) {
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
	for (const entry of metadata) {
		if (entry.kind === 'restriction' && entry.operations.includes(operation)) {
			return entry;
		}
	}
	return null;
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

export type CollectionRecordLeadingAccent = Readonly<{
	markerClass: string;
	tooltip: string;
}>;

/**
 * One shared leading accent for dense rows, list cards and Kanban cards.
 *
 * The accent states one of two things: the record is going through approval (system restriction,
 * brand) or it is locked against writes by the application (amber). Flags are labels, not states
 * of the record, and take no accent.
 */
export function collectionRecordLeadingAccent(
	metadata: readonly ResolvedCollectionRecordMetadata[]
): CollectionRecordLeadingAccent | null {
	const primary = metadata[0];
	if (primary === undefined || primary.kind !== 'restriction') return null;
	const tooltip = metadata.map(collectionRecordMetadataDescription).join(' • ');
	return {
		markerClass:
			primary.source === 'system'
				? 'inset-y-1 w-1 rounded-r-full bg-brand'
				: 'inset-y-1 w-1 rounded-r-full bg-warning',
		tooltip
	};
}
