import { Schema } from 'effect';
import type { CollectionRecord } from '@norbital-ai/std/collection';

const isString = Schema.is(Schema.String);

/** Resolves the canonical approval request from either a held domain row or the request inbox row. */
export const approvalRequestIdForRecord = (
	collectionName: string,
	record: CollectionRecord | undefined
): string | undefined => {
	if (record === undefined) return undefined;
	const value = Reflect.get(record, collectionName === 'approval_request' ? 'id' : 'approval_id');
	return isString(value) && value.length > 0 ? value : undefined;
};
