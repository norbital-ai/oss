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
 * One step of a declared approval flow, in the **authoring** shape — not the stored one.
 *
 * `approvers` holds `team.name`, and that is the whole point of the entry existing: the stored
 * `teams_that_can_approve` holds `team.norbital_id`, which a declaration cannot know because a team is
 * a runtime row. Reconciliation resolves the names against the tenant it is writing to.
 *
 * `.strict()` and the `min(1)`s are the checks the loose `Record<string, unknown>` had none of: a
 * misspelled key used to reach jsonb intact and fail at request time with a 400 that named nothing,
 * and an empty approver list used to store a step nobody could ever act on.
 */
type ManifestPolicyApprovalStepShape = {
	id: string;
	name: string;
	approvers: string[];
	description?: string | null;
	where?: Record<string, unknown>;
	steps?: ManifestPolicyApprovalStepShape[];
};

export const ManifestPolicyApprovalStepSchema: z.ZodType<ManifestPolicyApprovalStepShape> = z
	.object({
		id: nonEmpty,
		name: nonEmpty,
		approvers: z.array(nonEmpty).min(1),
		description: z.string().nullable().optional(),
		where: z.record(z.string(), z.unknown()).optional(),
		// `z.lazy`, not a getter: `.strict()` reads the shape eagerly, and a getter referring to the
		// const it is being assigned to throws at module load.
		steps: z.lazy(() => z.array(ManifestPolicyApprovalStepSchema)).optional()
	})
	.strict();

/** A declared approval flow, in the authoring shape. See {@link ManifestPolicyApprovalStepSchema}. */
export const ManifestPolicyApprovalSchema = z
	.object({
		id: nonEmpty,
		name: nonEmpty,
		where: z.record(z.string(), z.unknown()).optional(),
		supercededBy: z.array(nonEmpty).optional(),
		steps: z.array(ManifestPolicyApprovalStepSchema).min(1)
	})
	.strict();

/**
 * One access grant, as declared — `where`/`approval`, which reconciliation translates into the
 * `conditions`/`approval_config` the runtime policy engine consumes.
 *
 * `where` is deliberately the shape the `policy.grants` column holds, so the engine is unchanged and
 * the only thing that moves is where the rows come from. `approval` is not: it names teams by name,
 * and the ids only exist per tenant.
 */
export const ManifestPolicyGrantSchema = z
	.object({
		collection: nonEmpty,
		action: z.enum(['create', 'read', 'update', 'delete']),
		where: z.record(z.string(), z.unknown()).optional(),
		approval: ManifestPolicyApprovalSchema.nullable().optional()
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

/**
 * One conversational entry point, exactly as `src/channels/+<name>.channel.ts` declared it.
 *
 * In the manifest because `transport` names something only the *host* can supply, and the host reads
 * the manifest — not the workspace bundle — when it decides whether it can run this workspace. A
 * channel naming a transport the host has no provider for is refused at startup for the same reason
 * a file field without `fileStorage` is.
 */
export const ManifestChannelSchema = z
	.object({
		key: nonEmpty,
		transport: nonEmpty,
		policy: nonEmpty,
		description: z.string().nullable().optional(),
		task: z.string().optional()
	})
	.strict();

export const NorbitalManifestSchema = z
	.object({
		version: z.literal(1),
		collections: z.record(z.string(), ManifestCollectionEntrySchema),
		relationships: z.record(z.string(), ManifestRelationshipSchema),
		policies: z.record(z.string(), ManifestPolicySchema).optional(),
		channels: z.record(z.string(), ManifestChannelSchema).optional(),
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
		for (const [key, channel] of Object.entries(manifest.channels ?? {})) {
			if (channel.key !== key) {
				ctx.addIssue({
					code: 'custom',
					path: ['channels', key, 'key'],
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
export type ManifestPolicyApproval = DeepReadonly<z.infer<typeof ManifestPolicyApprovalSchema>>;
export type ManifestPolicyApprovalStep = DeepReadonly<
	z.infer<typeof ManifestPolicyApprovalStepSchema>
>;
export type NorbitalManifest = DeepReadonly<z.infer<typeof NorbitalManifestSchema>>;
