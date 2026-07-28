import { ManifestContext } from '@norbital-ai/platform-utils/manifest/context';
import { SYSTEM_COLUMN_NAMES } from '@norbital-ai/platform-utils/system/column_names';
import type { TApprovalRequest } from '@norbital-ai/platform-utils/system/types';
import { typeGuard } from '@norbital-ai/std/schema';
import { z } from 'zod';

const recordSchema = z.record(z.string(), z.unknown());

type TLockedRecordRef = TApprovalRequest['locked_record_refs'][number];
type TCollectionMetadataBase = ReturnType<ManifestContext['getCollection']>;
interface TCollectionMetadata extends TCollectionMetadataBase {
	collection_name: string;
}

type TLockType = TLockedRecordRef['lock_type'];

/** Root record + nested relationship payloads present in a mutation. */
export function collectLockedRecordRefs(
	rootCollection: TCollectionMetadata,
	payload: Record<string, unknown>,
	manifestCtx: ManifestContext,
	lockType: TLockType
): TLockedRecordRef[] {
	const refs: TLockedRecordRef[] = [];
	const seen = new Set<string>();
	addRef(rootCollection.collection_name, payload, lockType, refs, seen);
	walkLockedRefs(rootCollection, payload, manifestCtx, refs, seen, lockType);
	return refs;
}

function addRef(
	collectionName: string,
	record: Record<string, unknown>,
	lockType: TLockType,
	refs: TLockedRecordRef[],
	seen: Set<string>
): void {
	const rawRecordId = record[SYSTEM_COLUMN_NAMES.PKEY];
	const recordId = typeof rawRecordId === 'string' ? rawRecordId : undefined;
	if (!recordId) return;
	const dedupKey = `${collectionName}:${recordId}:${lockType}`;
	if (seen.has(dedupKey)) return;
	seen.add(dedupKey);
	refs.push({ collection_name: collectionName, record_id: recordId, lock_type: lockType });
}

function walkLockedRefs(
	collection: TCollectionMetadata,
	data: Record<string, unknown>,
	manifestCtx: ManifestContext,
	refs: TLockedRecordRef[],
	seen: Set<string>,
	lockType: TLockType
): void {
	for (const { name: relName, rel } of manifestCtx.getRelationshipsForCollection(
		collection.collection_name
	)) {
		const nestedData = data[relName];
		if (!Array.isArray(nestedData) || nestedData.length === 0) continue;

		const { otherCollection } = ManifestContext.getRelationshipDirection(
			rel,
			collection.collection_name
		);
		const childCollection = {
			...manifestCtx.getCollection(otherCollection),
			collection_name: otherCollection
		};

		for (const record of nestedData) {
			if (!typeGuard(recordSchema, record)) continue;
			addRef(childCollection.collection_name, record, lockType, refs, seen);
			walkLockedRefs(childCollection, record, manifestCtx, refs, seen, lockType);
		}
	}
}
