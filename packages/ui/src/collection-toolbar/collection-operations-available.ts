export const collectionOperationsAvailable = (operations: {
	readonly exportCount?: number;
	readonly importCount?: number;
	readonly integrationCount?: number;
	readonly deletion?: boolean;
}) =>
	(operations.exportCount ?? 0) > 0 ||
	(operations.importCount ?? 0) > 0 ||
	(operations.integrationCount ?? 0) > 0 ||
	operations.deletion === true;
