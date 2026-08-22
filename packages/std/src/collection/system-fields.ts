/** Framework-owned fields added to every collection by the shared model compiler. */
export const SYSTEM_COLLECTION_FIELD_NAMES: ReadonlyArray<string> = Object.freeze([
	'id',
	'created_at',
	'updated_at',
	'sys_period',
	'row_version',
	'approval_id'
]);

const SYSTEM_COLLECTION_FIELDS: ReadonlySet<string> = new Set(SYSTEM_COLLECTION_FIELD_NAMES);

/** Whether a field is compiler-owned rather than authored by a workspace model. */
export const isSystemCollectionField = (name: string): boolean =>
	SYSTEM_COLLECTION_FIELDS.has(name);
