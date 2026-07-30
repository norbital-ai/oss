import { z } from 'zod';
import { CollectionFieldSchema } from '../collection/schemas.js';

const nonEmpty = z.string().min(1);
const stringRecord = z.record(z.string(), z.string());
const unknownRecord = z.record(z.string(), z.unknown());

export const ManifestExclusionElementSchema = z
	.object({
		expr: nonEmpty,
		with: nonEmpty
	})
	.strict();

export const ManifestExclusionSchema = z
	.object({
		name: nonEmpty,
		using: z.enum(['gist', 'btree']).optional(),
		elements: z.array(ManifestExclusionElementSchema).min(1),
		where: nonEmpty.optional()
	})
	.strict();

export const ManifestCollectionEntrySchema = z
	.object({
		collection_name: nonEmpty,
		description: z.string().nullable(),
		record_label: z.string().nullable(),
		icon: z.string().nullable(),
		fields: z.array(CollectionFieldSchema).optional(),
		extensions: z
			.object({
				indexes: z.array(z.unknown()),
				exclusions: z.array(ManifestExclusionSchema).optional()
			})
			.strict(),
		enabled_semantic_search: z.boolean().nullable().optional(),
		hooks: z.record(z.string(), z.literal(true)),
		pipelines: z.record(z.string(), z.literal(true)),
		system: z.boolean().nullable()
	})
	.strict();

export const ManifestRelationshipSchema = z
	.object({
		name: nonEmpty,
		from: nonEmpty,
		to: nonEmpty,
		from_is_array: z.boolean(),
		to_is_array: z.boolean(),
		on_delete: z.literal('cascade').optional(),
		from_fields: z.array(nonEmpty).optional(),
		to_fields: z.array(nonEmpty).optional()
	})
	.strict();

export const ManifestAppSchema = z
	.object({
		name: nonEmpty,
		label: z.string().nullable().optional(),
		description: z.string().nullable(),
		icon: z.string().nullable(),
		defaultChild: z.string().nullable().optional(),
		thumbnail: z.string().nullable().optional(),
		banner: z.string().nullable().optional(),
		parent: z.string().nullable().optional(),
		config: z
			.object({
				whitelist: z
					.object({
						origins: z.array(nonEmpty).optional()
					})
					.strict()
					.optional()
			})
			.strict()
			.optional()
	})
	.strict();

export const ManifestHandlerEntrySchema = z
	.object({
		name: nonEmpty,
		description: z.string().nullable()
	})
	.strict();

export const ManifestAutomationAgentSpecSchema = z
	.object({
		kind: z.literal('agent'),
		task: nonEmpty,
		model: nonEmpty.optional(),
		systemPrompt: nonEmpty.optional(),
		collections: z.array(nonEmpty).optional(),
		access: z.enum(['read', 'write']).optional(),
		tools: z.array(nonEmpty).optional(),
		profile: nonEmpty.optional(),
		maxIterations: z.number().int().positive().optional(),
		maxTokens: z.number().int().positive().optional()
	})
	.strict();

export const ManifestAutomationSchema = z
	.object({
		trigger: z.union([
			z.object({ schedule: nonEmpty }).strict(),
			z
				.object({
					collection: nonEmpty,
					event: z.enum(['created', 'updated', 'deleted'])
				})
				.strict()
		]),
		spec: ManifestAutomationAgentSpecSchema.optional()
	})
	.strict();

export const ManifestSecretRequirementSchema = z
	.object({
		description: z.string(),
		required: z.boolean()
	})
	.strict();

const secretReferenceSchema = z
	.object({
		type: z.literal('secret'),
		name: nonEmpty
	})
	.strict();

const connectionSchema = z.union([
	z.object({ type: z.literal('connection'), name: nonEmpty }).strict(),
	z
		.object({
			type: z.literal('http'),
			baseUrl: z.url(),
			authentication: z
				.union([
					z.object({ type: z.literal('bearer'), token: secretReferenceSchema }).strict(),
					z
						.object({
							type: z.literal('header'),
							header: nonEmpty,
							value: secretReferenceSchema
						})
						.strict()
				])
				.optional()
		})
		.strict()
]);

const inboundBindingSchema = z
	.object({
		collection: nonEmpty,
		pipeline: z.literal('import'),
		origin: z.discriminatedUnion('type', [
			z.object({ type: z.literal('system-event'), event: nonEmpty }).strict(),
			z
				.object({
					type: z.literal('webhook'),
					events: z.array(nonEmpty).optional(),
					authentication: z
						.object({
							type: z.literal('hmac-sha256'),
							secret: secretReferenceSchema,
							signatureHeader: nonEmpty.optional()
						})
						.strict()
						.optional(),
					eventId: z.object({ header: nonEmpty }).strict().optional()
				})
				.strict(),
			z
				.object({
					type: z.literal('api-pull'),
					schedule: nonEmpty,
					url: z.url(),
					method: z.enum(['GET', 'POST']).optional(),
					secretHeaders: z.record(z.string(), secretReferenceSchema).optional(),
					cursorQuery: z.string().optional(),
					nextCursorHeader: nonEmpty.optional()
				})
				.strict()
		])
	})
	.strict();

const integrationDestinationSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('system-event'), event: nonEmpty }).strict(),
	z
		.object({
			type: z.literal('api'),
			url: z.url(),
			method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']),
			headers: stringRecord.optional(),
			secretHeaders: z.record(z.string(), secretReferenceSchema).optional()
		})
		.strict(),
	z
		.object({
			type: z.literal('webhook'),
			url: z.union([z.url(), secretReferenceSchema]),
			authentication: z
				.object({ type: z.literal('bearer'), token: secretReferenceSchema })
				.strict()
				.optional()
		})
		.strict()
]);

export const ManifestIntegrationDefinitionSchema = z
	.object({
		connection: connectionSchema.optional(),
		inbound: z.record(z.string(), inboundBindingSchema).optional(),
		outbound: z
			.record(
				z.string(),
				z
					.object({
						collection: nonEmpty,
						pipeline: z.literal('export'),
						trigger: z.literal('collection-events'),
						destination: integrationDestinationSchema
					})
					.strict()
			)
			.optional(),
		identity: z.object({ externalEntity: nonEmpty }).strict().optional(),
		conflicts: unknownRecord.optional(),
		reconciliation: z.object({ schedule: nonEmpty }).strict().optional()
	})
	.strict();

export const ManifestIntegrationSchema = z
	.object({
		name: nonEmpty,
		definition: ManifestIntegrationDefinitionSchema
	})
	.strict();

/**
 * One access grant, exactly as the runtime policy engine already consumes it.
 *
 * Deliberately the same shape the `policy.grants` column holds: the engine is unchanged, and the only
 * thing that moves is where the rows come from. Declaring them in source means a grant is reviewable
 * in a diff and a typo is a compile error, instead of a row somebody has to remember to seed.
 */
export const ManifestPolicyGrantSchema = z
	.object({
		collection: nonEmpty,
		action: z.enum(['create', 'read', 'update', 'delete']),
		where: z.record(z.string(), z.unknown()).optional(),
		approval: z.record(z.string(), z.unknown()).nullable().optional()
	})
	.strict();

export const ManifestPolicySchema = z
	.object({
		key: nonEmpty,
		name: nonEmpty,
		description: z.string().nullable().optional(),
		apps: z.array(nonEmpty).optional(),
		grants: z.array(ManifestPolicyGrantSchema)
	})
	.strict();

export const NorbitalManifestSchema = z
	.object({
		version: z.literal(1),
		collections: z.record(z.string(), ManifestCollectionEntrySchema),
		relationships: z.record(z.string(), ManifestRelationshipSchema),
		policies: z.record(z.string(), ManifestPolicySchema).optional(),
		apps: z.record(z.string(), ManifestAppSchema).optional(),
		handlers: z.record(z.string(), ManifestHandlerEntrySchema).optional(),
		automations: z.record(z.string(), ManifestAutomationSchema),
		env: z
			.object({
				public: stringRecord.optional(),
				secret: stringRecord.optional()
			})
			.strict()
			.optional(),
		secrets: z.record(z.string(), ManifestSecretRequirementSchema).optional(),
		integrations: z.record(z.string(), ManifestIntegrationSchema).optional()
	})
	.strict()
	.superRefine((manifest, ctx) => {
		for (const [key, collection] of Object.entries(manifest.collections)) {
			if (collection.collection_name !== key) {
				ctx.addIssue({
					code: 'custom',
					path: ['collections', key, 'collection_name'],
					message: 'must match its map key'
				});
			}
		}
		for (const [key, integration] of Object.entries(manifest.integrations ?? {})) {
			if (integration.name !== key) {
				ctx.addIssue({
					code: 'custom',
					path: ['integrations', key, 'name'],
					message: 'must match its map key'
				});
			}
		}
		for (const [key, policy] of Object.entries(manifest.policies ?? {})) {
			if (policy.key !== key) {
				ctx.addIssue({
					code: 'custom',
					path: ['policies', key, 'key'],
					message: 'must match its map key'
				});
			}
			// A grant on a collection the workspace does not define can never match, so it is dead
			// permission surface that reads as if it grants something.
			for (const [index, grant] of policy.grants.entries()) {
				if (!manifest.collections[grant.collection]) {
					ctx.addIssue({
						code: 'custom',
						path: ['policies', key, 'grants', index, 'collection'],
						message: `unknown collection "${grant.collection}"`
					});
				}
			}
		}
	});

type DeepReadonly<T> = T extends (...args: never[]) => unknown
	? T
	: T extends readonly (infer TItem)[]
		? readonly DeepReadonly<TItem>[]
		: T extends object
			? { readonly [TKey in keyof T]: DeepReadonly<T[TKey]> }
			: T;

export type ManifestHookEntry = true;
export type ManifestPipelineEntry = true;
export type ManifestHookKey = string;
export type ManifestExclusionElement = DeepReadonly<z.infer<typeof ManifestExclusionElementSchema>>;
export type ManifestExclusion = DeepReadonly<z.infer<typeof ManifestExclusionSchema>>;
export type ManifestCollectionEntry = DeepReadonly<z.infer<typeof ManifestCollectionEntrySchema>>;
export type ManifestRelationship = DeepReadonly<z.infer<typeof ManifestRelationshipSchema>>;
export type ManifestApp = DeepReadonly<z.infer<typeof ManifestAppSchema>>;
export type ManifestHandlerEntry = DeepReadonly<z.infer<typeof ManifestHandlerEntrySchema>>;
export type ManifestAutomationAgentSpec = DeepReadonly<
	z.infer<typeof ManifestAutomationAgentSpecSchema>
>;
export type ManifestAutomationTemplate = DeepReadonly<z.infer<typeof ManifestAutomationSchema>>;
export type ManifestEnv = DeepReadonly<NonNullable<z.infer<typeof NorbitalManifestSchema>['env']>>;
export type ManifestSecretRequirement = DeepReadonly<
	z.infer<typeof ManifestSecretRequirementSchema>
>;
export type ManifestIntegration = DeepReadonly<z.infer<typeof ManifestIntegrationSchema>>;
export type NorbitalManifest = DeepReadonly<z.infer<typeof NorbitalManifestSchema>>;
