import { z } from 'zod';

export const ExpandSpecSchema = z.record(z.string(), z.unknown());

export const CollectionFilterSchema = z.object({
	path: z.array(z.string().min(1)).min(1).max(2),
	operator: z.enum([
		'eq',
		'ne',
		'gt',
		'gte',
		'lt',
		'lte',
		'ilike',
		'isNull',
		'isNotNull',
		'arrayContains',
		'arrayOverlaps',
		'contains_date',
		'overlaps'
	]),
	operand: z.unknown().optional()
});

const collectionFiltersField = {
	filters: z.array(CollectionFilterSchema).max(20).optional()
};

const queryFields = {
	with: ExpandSpecSchema.optional(),
	where: z.record(z.string(), z.unknown()).optional(),
	search: z.string().trim().max(200).optional(),
	columns: z.record(z.string(), z.boolean()).optional(),
	orderBy: z.record(z.string(), z.union([z.literal('asc'), z.literal('desc')])).optional()
};

export const FindManyWireSchema = z
	.object({
		collection: z.string(),
		bypass_secret: z.string().optional(),
		...collectionFiltersField,
		...queryFields,
		limit: z.number().int().positive().max(5000).optional(),
		after: z.string().min(1).max(4096).optional()
	})
	.strict();

export const CollectionPageWireSchema = z.object({
	rows: z.array(z.record(z.string(), z.unknown())),
	nextCursor: z.string().nullable()
});

export const FindFirstWireSchema = z
	.object({
		collection: z.string(),
		bypass_secret: z.string().optional(),
		...queryFields
	})
	.strict();

export const FindHistoryWireSchema = z
	.object({
		collection: z.string(),
		record_id: z.string().uuid(),
		limit: z.number().int().positive().max(500).default(250)
	})
	.strict();

export const CollectionRecordHistoryEntrySchema = z.object({
	values: z.record(z.string(), z.unknown()),
	validFrom: z.string(),
	validTo: z.string().nullable(),
	version: z.coerce.number().int().positive()
});

export const FindGroupedWireSchema = z.object({
	collection: z.string(),
	bypass_secret: z.string().optional(),
	...collectionFiltersField,
	...queryFields,
	limit: z.number().int().positive().max(500).default(100),
	group: z.object({
		by: z.string(),
		lanes: z.array(z.unknown()).optional()
	})
});

export const CountWireSchema = z.object({
	collection: z.string(),
	bypass_secret: z.string().optional(),
	...collectionFiltersField,
	...queryFields,
	limit: z.number().int().positive().optional()
});

export const CreateWireSchema = z.object({
	collection: z.string(),
	bypass_secret: z.string().optional(),
	input: z.record(z.string(), z.unknown())
});

export const CreateManyWireSchema = z.object({
	collection: z.string(),
	bypass_secret: z.string().optional(),
	inputs: z.array(z.record(z.string(), z.unknown()))
});

export const UpdateWireSchema = z.object({
	collection: z.string(),
	bypass_secret: z.string().optional(),
	record_id: z.string(),
	input: z.record(z.string(), z.unknown())
});

export const UpdateManyWireSchema = z.object({
	collection: z.string(),
	bypass_secret: z.string().optional(),
	updates: z
		.array(
			z.object({
				record_id: z.string(),
				input: z.record(z.string(), z.unknown())
			})
		)
		.min(1)
});

export const DeleteWireSchema = z.object({
	collection: z.string(),
	bypass_secret: z.string().optional(),
	record_id: z.string()
});

export const ExportRecordsWireSchema = z.object({
	collection_name: z.string(),
	record_ids: z.array(z.string()).optional(),
	with: ExpandSpecSchema.optional(),
	where: z.record(z.string(), z.unknown()).optional(),
	limit: z.number().int().positive().max(10_000).optional(),
	bypass_secret: z.string().optional()
});

export const ImportRecordsWireSchema = z.object({
	collection_name: z.string(),
	import_data: z.unknown(),
	with: ExpandSpecSchema.optional(),
	bypass_secret: z.string().optional()
});
