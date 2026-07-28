import { z } from 'zod';
import type { CollectionDefinition, CollectionField, CollectionRelationship } from './types.js';

export const NumericRendererVariantSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('number') }),
	z.object({ type: z.literal('star-rating'), max: z.number().int().min(1).max(20) }),
	z.object({ type: z.literal('progress'), denominator: z.number().finite().positive() })
]);

export const CollectionFieldSchema = z.object({
	name: z.string(),
	kind: z.string(),
	nullable: z.boolean(),
	label: z.string().optional(),
	array: z.boolean().optional(),
	readOnly: z.boolean().optional(),
	values: z.array(z.string()).optional(),
	options: z.record(z.string(), z.unknown()).optional(),
	currencies: z.array(z.string()).optional(),
	mimeTypes: z.array(z.string()).optional(),
	variant: NumericRendererVariantSchema.optional(),
	relation: z
		.object({
			name: z.string(),
			target: z.string()
		})
		.optional()
}) satisfies z.ZodType<CollectionField>;

export const CollectionRelationshipSchema = z.object({
	name: z.string(),
	target: z.string(),
	cardinality: z.union([z.literal('one'), z.literal('many')])
}) satisfies z.ZodType<CollectionRelationship>;

export const CollectionDefinitionSchema = z.object({
	name: z.string(),
	recordLabel: z.string().nullable().optional(),
	system: z.boolean().optional(),
	fields: z.array(CollectionFieldSchema),
	relationships: z.array(CollectionRelationshipSchema).optional()
}) satisfies z.ZodType<CollectionDefinition>;

export const CollectionDefinitionsSchema = z.record(z.string(), CollectionDefinitionSchema);
