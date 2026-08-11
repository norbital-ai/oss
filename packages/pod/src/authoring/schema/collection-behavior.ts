import type { z } from 'zod';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { AfterHookApi, BeforeApi, HookApi } from '../workspace/hook-api.js';
import type { TExportManifest } from '../automations/pipelines.js';
import type { InferZodInput } from './extract.js';
import type { MutationInsertFor, MutationUpdateFor, PickableZodSchema } from './input-schemas.js';
import type { AnySchema, SchemaRow, TableName } from './types.js';
import type {
	CollectionIntegrationDefinition,
	CollectionMutationEvent,
	CollectionReceiveBinding,
	CollectionSendBinding,
	CollectionSendDestination
} from '../integrations/integrations.js';

type DefaultInputSchema<
	S extends AnySchema,
	N extends TableName<S>,
	K extends 'create' | 'update'
> = K extends 'create'
	? PickableZodSchema<MutationInsertFor<S, N>>
	: PickableZodSchema<MutationUpdateFor<S, N>>;

export type CreateInputSchema<S extends AnySchema, N extends TableName<S>, TDef> = TDef extends {
	create: infer C;
}
	? C extends { input?: infer Input }
		? Input extends z.ZodTypeAny
			? z.ZodTypeAny extends Input
				? DefaultInputSchema<S, N, 'create'>
				: Input
			: DefaultInputSchema<S, N, 'create'>
		: DefaultInputSchema<S, N, 'create'>
	: DefaultInputSchema<S, N, 'create'>;

export type UpdateInputSchema<S extends AnySchema, N extends TableName<S>, TDef> = TDef extends {
	update: infer U;
}
	? U extends { input?: infer Input }
		? Input extends z.ZodTypeAny
			? z.ZodTypeAny extends Input
				? DefaultInputSchema<S, N, 'update'>
				: Input
			: DefaultInputSchema<S, N, 'update'>
		: DefaultInputSchema<S, N, 'update'>
	: DefaultInputSchema<S, N, 'update'>;

export type CreateInput<S extends AnySchema, N extends TableName<S>, TDef> = TDef extends {
	create: infer C;
}
	? C extends { input?: infer Input }
		? Input extends z.ZodTypeAny
			? z.ZodTypeAny extends Input
				? MutationInsertFor<S, N>
				: InferZodInput<Input>
			: MutationInsertFor<S, N>
		: MutationInsertFor<S, N>
	: MutationInsertFor<S, N>;

export type UpdateInput<S extends AnySchema, N extends TableName<S>, TDef> = Partial<
	TDef extends { update: infer U }
		? U extends { input?: infer Input }
			? Input extends z.ZodTypeAny
				? z.ZodTypeAny extends Input
					? MutationUpdateFor<S, N>
					: InferZodInput<Input>
				: MutationUpdateFor<S, N>
			: MutationUpdateFor<S, N>
		: MutationUpdateFor<S, N>
>;

export type CreateMutationPayload<S extends AnySchema, N extends TableName<S>> = MutationInsertFor<
	S,
	N
> &
	Record<string, unknown>;

/**
 * A hook as it is authored: the code, plus one sentence saying what it does to the record.
 *
 * The description is mandatory and is not a comment, because it leaves the file — it is carried into
 * the manifest, which is what the Workspace Studio reads when it explains a collection to somebody
 * who will never open `+hooks.ts`. A comment would say the same thing only to the audience that is
 * already reading the handler.
 *
 * Requiring the object form is also why there is no bare-function shape any more: an optional
 * description is a description nobody writes, and the studio then falls back to naming a hook key,
 * which says when the code runs and never what it refuses.
 */
export type DescribedHook<THandler> = {
	readonly description: string;
	readonly handler: THandler;
};

type CreateHookHandlers<S extends AnySchema, N extends TableName<S>, TInput> = {
	readonly before?: (ctx: {
		readonly input: TInput;
		readonly api: HookApi<S>;
	}) => Promise<TInput | CreateMutationPayload<S, N>>;
	readonly after?: (ctx: {
		readonly record: SchemaRow<S, N>;
		readonly api: AfterHookApi<S>;
	}) => Promise<void>;
};

type UpdateHookHandlers<S extends AnySchema, N extends TableName<S>, TInput> = {
	readonly before?: (ctx: {
		readonly input: Partial<TInput>;
		readonly existing: SchemaRow<S, N>;
		readonly api: HookApi<S>;
	}) => Promise<Partial<TInput>>;
	readonly after?: (ctx: {
		readonly record: SchemaRow<S, N>;
		readonly api: AfterHookApi<S>;
	}) => Promise<void>;
};

type DeleteHookHandlers<S extends AnySchema, N extends TableName<S>> = {
	readonly before?: (ctx: {
		readonly existing: SchemaRow<S, N>;
		readonly api: HookApi<S>;
	}) => Promise<void>;
	readonly after?: (ctx: {
		readonly record: SchemaRow<S, N>;
		readonly api: AfterHookApi<S>;
	}) => Promise<void>;
};

type CreateHooks<S extends AnySchema, N extends TableName<S>, TInput> = {
	readonly before?: DescribedHook<NonNullable<CreateHookHandlers<S, N, TInput>['before']>>;
	readonly after?: DescribedHook<NonNullable<CreateHookHandlers<S, N, TInput>['after']>>;
};

type UpdateHooks<S extends AnySchema, N extends TableName<S>, TInput> = {
	readonly before?: DescribedHook<NonNullable<UpdateHookHandlers<S, N, TInput>['before']>>;
	readonly after?: DescribedHook<NonNullable<UpdateHookHandlers<S, N, TInput>['after']>>;
};

type DeleteHooks<S extends AnySchema, N extends TableName<S>> = {
	readonly before?: DescribedHook<NonNullable<DeleteHookHandlers<S, N>['before']>>;
	readonly after?: DescribedHook<NonNullable<DeleteHookHandlers<S, N>['after']>>;
};

type SchemaInputPicker<S extends AnySchema, N extends TableName<S>, K extends 'create' | 'update'> =
	z.ZodTypeAny | DefaultInputSchema<S, N, K>;

type ExportPipelineHandler<S extends AnySchema, N extends TableName<S>> = (
	ctx: {
		readonly scope: { readonly records: ReadonlyArray<SchemaRow<S, N>> };
		readonly collection: { readonly name: string };
	},
	api: BeforeApi<S>
) => Promise<TExportManifest>;

type ImportPipelineHandler<S extends AnySchema, N extends TableName<S>> = (
	ctx: {
		readonly scope: { readonly import_data: unknown };
		readonly collection: { readonly name: string };
	},
	api: BeforeApi<S>
) => Promise<readonly MutationInsertFor<S, N>[]>;

type AuthoredMutationSection = {
	readonly input?: z.ZodTypeAny;
	readonly before?: unknown;
	readonly after?: unknown;
	readonly hooks?: never;
};

export type CollectionMutationDef = {
	readonly create?: AuthoredMutationSection;
	readonly update?: AuthoredMutationSection;
	readonly delete?: Omit<AuthoredMutationSection, 'input'>;
};

export type CollectionBehaviorDef<
	S extends AnySchema,
	N extends TableName<S>
> = CollectionMutationDef & {
	readonly export?: { readonly description: string; readonly handler: unknown };
	readonly import?: {
		readonly description: string;
		readonly input: z.ZodTypeAny;
		readonly handler: unknown;
	};
	readonly integrations?: Readonly<Record<string, CollectionIntegrationDefinition>>;
};

type Awaitable<T> = T | Promise<T>;

type ReceiveBindingFor<TImport> = Omit<CollectionReceiveBinding, 'input'> & {
	readonly input?: z.ZodType<TImport>;
};

type CollectionEventTrigger<S extends AnySchema, N extends TableName<S>> =
	| CollectionMutationEvent
	| {
			readonly create?: (ctx: { readonly record: SchemaRow<S, N> }) => boolean;
			readonly update?: (ctx: {
				readonly previous: SchemaRow<S, N>;
				readonly record: SchemaRow<S, N>;
			}) => boolean;
			readonly delete?: (ctx: { readonly record: SchemaRow<S, N> }) => boolean;
	  };

type SendBindingFor<
	S extends AnySchema,
	N extends TableName<S>,
	TExport
> = CollectionSendDestination & {
	readonly on: CollectionEventTrigger<S, N>;
	readonly transform?: (ctx: { readonly output: TExport }, api: BeforeApi<S>) => Awaitable<unknown>;
};

type IntegrationFor<S extends AnySchema, N extends TableName<S>, TImport, TExport> = Omit<
	CollectionIntegrationDefinition,
	'receive' | 'send'
> & {
	readonly receive?: Readonly<Record<string, ReceiveBindingFor<TImport>>>;
	readonly send?: Readonly<Record<string, SendBindingFor<S, N, TExport>>>;
};

type IntegrationsFor<S extends AnySchema, N extends TableName<S>, TImport, TExport> = Readonly<
	Record<string, IntegrationFor<S, N, TImport, TExport>>
>;

type CreateSectionFor<S extends AnySchema, N extends TableName<S>, C> = C extends object
	? Omit<C, 'input' | 'before' | 'after'> & {
			readonly input?: SchemaInputPicker<S, N, 'create'>;
			readonly before?: CreateHooks<S, N, CreateInput<S, N, { readonly create: C }>>['before'];
			readonly after?: CreateHooks<S, N, CreateInput<S, N, { readonly create: C }>>['after'];
		}
	: never;

type UpdateSectionFor<S extends AnySchema, N extends TableName<S>, U> = U extends object
	? Omit<U, 'input' | 'before' | 'after'> & {
			readonly input?: SchemaInputPicker<S, N, 'update'>;
			readonly before?: UpdateHooks<S, N, UpdateInput<S, N, { readonly update: U }>>['before'];
			readonly after?: UpdateHooks<S, N, UpdateInput<S, N, { readonly update: U }>>['after'];
		}
	: never;

type DeleteSectionFor<S extends AnySchema, N extends TableName<S>, D> = D extends object
	? Omit<D, 'before' | 'after'> & {
			readonly before?: DeleteHooks<S, N>['before'];
			readonly after?: DeleteHooks<S, N>['after'];
		}
	: {
			readonly before?: DeleteHooks<S, N>['before'];
			readonly after?: DeleteHooks<S, N>['after'];
		};

export type CollectionDefFor<
	S extends AnySchema,
	N extends TableName<S>,
	TDef extends CollectionMutationDef
> = Omit<TDef, 'create' | 'update' | 'delete'> & {
	readonly create?: 'create' extends keyof TDef ? CreateSectionFor<S, N, TDef['create']> : never;
	readonly update?: 'update' extends keyof TDef ? UpdateSectionFor<S, N, TDef['update']> : never;
	readonly delete?: 'delete' extends keyof TDef ? DeleteSectionFor<S, N, TDef['delete']> : never;
};

export type CollectionAuthoringDef<
	S extends AnySchema,
	N extends TableName<S>,
	TMutation extends CollectionMutationDef,
	TImportSchema extends z.ZodTypeAny,
	TExport extends TExportManifest
> = CollectionDefFor<S, N, TMutation> & {
	readonly import?: {
		/** What this pipeline accepts and what it turns into rows. Carried into the manifest. */
		readonly description: string;
		readonly input: TImportSchema;
		readonly handler: (
			ctx: { readonly input: z.output<TImportSchema> },
			api: BeforeApi<S>
		) => Promise<readonly MutationInsertFor<S, N>[]>;
	};
	readonly export?: {
		/** What this pipeline emits and who consumes it. Carried into the manifest. */
		readonly description: string;
		readonly handler: (
			ctx: { readonly records: ReadonlyArray<SchemaRow<S, N>> },
			api: BeforeApi<S>
		) => Promise<TExport>;
	};
	readonly integrations?: IntegrationsFor<S, N, z.output<TImportSchema>, TExport>;
};

type FilesystemCollectionDefinition<
	S extends AnySchema,
	N extends TableName<S>
> = CollectionAuthoringDef<S, N, CollectionMutationDef, z.ZodTypeAny, TExportManifest>;

export type CollectionHooks<S extends AnySchema, N extends TableName<S>> = {
	readonly create?: {
		readonly input?: SchemaInputPicker<S, N, 'create'>;
		readonly before?: CreateHooks<S, N, MutationInsertFor<S, N>>['before'];
		readonly after?: CreateHooks<S, N, MutationInsertFor<S, N>>['after'];
	};
	readonly update?: {
		readonly input?: SchemaInputPicker<S, N, 'update'>;
		readonly before?: UpdateHooks<S, N, MutationUpdateFor<S, N>>['before'];
		readonly after?: UpdateHooks<S, N, MutationUpdateFor<S, N>>['after'];
	};
	readonly delete?: {
		readonly before?: DeleteHooks<S, N>['before'];
		readonly after?: DeleteHooks<S, N>['after'];
	};
};

export type CollectionPipelines<S extends AnySchema, N extends TableName<S>> = {
	readonly export?: FilesystemCollectionDefinition<S, N>['export'];
	readonly import?: FilesystemCollectionDefinition<S, N>['import'];
};

export type CollectionIntegrations<S extends AnySchema, N extends TableName<S>> = NonNullable<
	FilesystemCollectionDefinition<S, N>['integrations']
>;

export type ResolvedCollectionDef<
	S extends AnySchema,
	N extends TableName<S>,
	TMutation extends CollectionMutationDef,
	TImportSchema extends z.ZodTypeAny,
	TExport extends TExportManifest
> = TMutation & {
	readonly import?: CollectionAuthoringDef<S, N, TMutation, TImportSchema, TExport>['import'];
	readonly export?: CollectionAuthoringDef<S, N, TMutation, TImportSchema, TExport>['export'];
	readonly integrations?: IntegrationsFor<S, N, z.output<TImportSchema>, TExport>;
};

export type CollectionBehaviorFromDef<
	S extends AnySchema,
	N extends TableName<S>,
	TDef extends CollectionBehaviorDef<S, N>
> = {
	readonly __kind: 'collection-behavior';
	readonly name: N;
	readonly table: S['tables'][N];
	readonly def: TDef;
	readonly inputs: {
		readonly create: CreateInputSchema<S, N, TDef>;
		readonly update: UpdateInputSchema<S, N, TDef>;
	};
	readonly create?: ResolvedMutationSection<S, N, 'create'>;
	readonly update?: ResolvedMutationSection<S, N, 'update'>;
	readonly delete?: ResolvedMutationSection<S, N, 'delete'>;
	readonly export?: ExportPipelineHandler<S, N>;
	readonly import?: ImportPipelineHandler<S, N>;
	readonly pipelineDescriptions?: PipelineDescriptions;
	readonly integrations?: TDef['integrations'];
};

export type CollectionBehavior<
	S extends AnySchema,
	N extends TableName<S>,
	TDef extends CollectionBehaviorDef<S, N> = CollectionBehaviorDef<S, N>
> = CollectionBehaviorFromDef<S, N, TDef>;

/** Erased hook contexts — shapes passed by runtime dispatch (tenant_run, collection_ops). */
export type ErasedCreateBeforeCtx = {
	readonly input?: Record<string, unknown>;
	readonly api: HookApi;
};

export type ErasedCreateAfterCtx = {
	readonly record: Record<string, unknown>;
	readonly api: AfterHookApi;
};

export type ErasedUpdateBeforeCtx = {
	readonly input?: Record<string, unknown>;
	readonly existing?: Record<string, unknown>;
	readonly api: HookApi;
};

export type ErasedUpdateAfterCtx = {
	readonly record: Record<string, unknown>;
	readonly api: AfterHookApi;
};

export type ErasedDeleteBeforeCtx = {
	readonly existing?: Record<string, unknown>;
	readonly api: HookApi;
};

export type ErasedDeleteAfterCtx = {
	readonly record: Record<string, unknown>;
	readonly api: AfterHookApi;
};

/**
 * What each declared hook of one mutation section says about itself, kept beside the handlers.
 *
 * Split from the bundle rather than stored on it because dispatch is on the hot path and only ever
 * wants something callable; folding prose into the value every mutation reaches for would make every
 * call site unwrap a wrapper it has no use for.
 */
export type HookDescriptions = {
	readonly before?: string;
	readonly after?: string;
};

/** The same, for a collection's `import` / `export` pipelines. */
export type PipelineDescriptions = {
	readonly import?: string;
	readonly export?: string;
};

/** Wide hook bundle for action-agnostic accessors (e.g. `collectionHooks`). */
export type AnyHookBundle = {
	readonly before?: (ctx: {
		readonly input?: Record<string, unknown>;
		readonly existing?: Record<string, unknown>;
		readonly api: HookApi;
	}) => Promise<Record<string, unknown> | void>;
	readonly after?: (ctx: {
		readonly record: Record<string, unknown>;
		readonly api: AfterHookApi;
	}) => Promise<void>;
};

/**
 * Schema-erased structural view of a built collection behavior.
 * Runtime plumbing (registry lookups, manifest building, hook dispatch) uses this
 * instead of instantiating the full generic `CollectionBehavior`, which is too
 * heavy for the compiler at schema-agnostic call sites.
 */
export type AnyCollectionBehavior = {
	readonly __kind: 'collection-behavior';
	readonly name: string;
	readonly table: PgTable;
	readonly inputs: { readonly create: z.ZodType; readonly update: z.ZodType };
	readonly create?: { readonly hooks?: AnyHookBundle; readonly descriptions?: HookDescriptions };
	readonly update?: { readonly hooks?: AnyHookBundle; readonly descriptions?: HookDescriptions };
	readonly delete?: { readonly hooks?: AnyHookBundle; readonly descriptions?: HookDescriptions };
	readonly export?: unknown;
	readonly import?: unknown;
	readonly pipelineDescriptions?: PipelineDescriptions;
	readonly integrations?: Readonly<Record<string, CollectionIntegrationDefinition>>;
};

export function requireCollectionBehavior(value: unknown): AnyCollectionBehavior {
	if (!isCollectionBehavior(value)) {
		throw new Error('Expected a collection behavior');
	}
	return value;
}

type ResolvedMutationSection<
	S extends AnySchema,
	N extends TableName<S>,
	K extends 'create' | 'update' | 'delete'
> = K extends 'delete'
	? { readonly hooks?: DeleteHookHandlers<S, N>; readonly descriptions?: HookDescriptions }
	: K extends 'create'
		? {
				readonly input?: SchemaInputPicker<S, N, 'create'>;
				readonly hooks?: CreateHookHandlers<S, N, MutationInsertFor<S, N>>;
				readonly descriptions?: HookDescriptions;
			}
		: {
				readonly input?: SchemaInputPicker<S, N, 'update'>;
				readonly hooks?: UpdateHookHandlers<S, N, MutationUpdateFor<S, N>>;
				readonly descriptions?: HookDescriptions;
			};

/**
 * Refuse a hook written as a bare function, or with nothing said about it.
 *
 * The message names the file shape rather than the type, because this is the one authoring error a
 * tenant author hits by writing the older, shorter form from memory — and a structural type error on
 * a deeply generic hook context is unreadable next to it.
 */
function describedHook(
	kind: 'create' | 'update' | 'delete',
	phase: 'before' | 'after',
	value: unknown
): { handler: unknown; description: string } {
	if (typeof value === 'function') {
		throw new Error(
			`Collection ${kind}.${phase} must be declared as { description, handler }, not a bare function`
		);
	}
	const described = value as { handler?: unknown; description?: unknown };
	if (typeof described?.handler !== 'function') {
		throw new Error(`Collection ${kind}.${phase} is missing a handler function`);
	}
	if (typeof described.description !== 'string' || !described.description.trim()) {
		throw new Error(`Collection ${kind}.${phase} requires a non-empty description`);
	}
	return { handler: described.handler, description: described.description };
}

/**
 * Split an authored section into what dispatch calls and what the manifest carries.
 *
 * Unwrapping here — rather than at every `collectionHooks(...)?.before` call site — is what keeps the
 * description free: the runtime keeps receiving a plain function, so no mutation path had to learn
 * about a wrapper it never reads.
 */
function buildMutationSection(
	kind: 'create' | 'update' | 'delete',
	section: AuthoredMutationSection | undefined
) {
	if (!section) return undefined;
	const allowedKeys =
		kind === 'delete' ? new Set(['before', 'after']) : new Set(['input', 'before', 'after']);
	const unsupportedKey = Object.keys(section).find((key) => !allowedKeys.has(key));
	if (unsupportedKey) {
		throw new Error(`Unsupported ${kind} mutation property "${unsupportedKey}"`);
	}
	const { input } = section;
	const before = section.before ? describedHook(kind, 'before', section.before) : undefined;
	const after = section.after ? describedHook(kind, 'after', section.after) : undefined;
	const hooks =
		before || after
			? {
					...(before ? { before: before.handler } : {}),
					...(after ? { after: after.handler } : {})
				}
			: undefined;
	const descriptions =
		before || after
			? {
					...(before ? { before: before.description } : {}),
					...(after ? { after: after.description } : {})
				}
			: undefined;
	return {
		...(input ? { input } : {}),
		...(hooks ? { hooks } : {}),
		...(descriptions ? { descriptions } : {})
	};
}

function pipelineDescription(kind: 'import' | 'export', description: unknown): string {
	if (typeof description !== 'string' || !description.trim()) {
		throw new Error(`Collection ${kind} pipeline requires a non-empty description`);
	}
	return description;
}

function normalizeImportPipeline<S extends AnySchema, N extends TableName<S>>(importDef: {
	readonly input: z.ZodTypeAny;
	readonly handler: unknown;
}): ImportPipelineHandler<S, N> | undefined {
	const { input, handler } = importDef;
	if (typeof handler !== 'function') throw new Error('Import pipeline handler must be a function');
	return async (ctx, api) => {
		const import_data = input.parse(ctx.scope.import_data);
		return Reflect.apply(handler, undefined, [{ input: import_data }, api]);
	};
}

function normalizeExportPipeline<S extends AnySchema, N extends TableName<S>>(exportDef: {
	readonly handler: unknown;
}): ExportPipelineHandler<S, N> {
	const handler = exportDef.handler;
	if (typeof handler !== 'function') {
		throw new Error('Export pipeline handler must be a function');
	}
	return ({ scope }, api) => Reflect.apply(handler, undefined, [{ records: scope.records }, api]);
}

// stupidity:allow R5b -- public authoring boundary checks the private collection brand before narrowing.
export function isCollectionBehavior(value: unknown): value is AnyCollectionBehavior {
	return (
		typeof value === 'object' &&
		value !== null &&
		Reflect.get(value, '__kind') === 'collection-behavior'
	);
}

export function buildCollectionBehavior<
	S extends AnySchema,
	N extends TableName<S>,
	const TDef extends CollectionBehaviorDef<S, N>
>(schema: S, name: N, def: TDef): CollectionBehaviorFromDef<S, N, TDef> {
	const createSection = buildMutationSection('create', def.create);
	const updateSection = buildMutationSection('update', def.update);
	const deleteSection = buildMutationSection('delete', def.delete);

	const createSchema = createSection?.input ?? schema.inputs[name].create;
	const updateSchema = updateSection?.input ?? schema.inputs[name].update;

	return {
		__kind: 'collection-behavior',
		name,
		table: schema.tables[name],
		def,
		inputs: {
			create: createSchema as CreateInputSchema<S, N, TDef>,
			update: updateSchema as UpdateInputSchema<S, N, TDef>
		},
		...(createSection ? { create: createSection as ResolvedMutationSection<S, N, 'create'> } : {}),
		...(updateSection ? { update: updateSection as ResolvedMutationSection<S, N, 'update'> } : {}),
		...(deleteSection ? { delete: deleteSection as ResolvedMutationSection<S, N, 'delete'> } : {}),
		...(def.export ? { export: normalizeExportPipeline<S, N>(def.export) } : {}),
		...(def.import ? { import: normalizeImportPipeline<S, N>(def.import) } : {}),
		...(def.export || def.import
			? {
					pipelineDescriptions: {
						...(def.export
							? { export: pipelineDescription('export', def.export.description) }
							: {}),
						...(def.import ? { import: pipelineDescription('import', def.import.description) } : {})
					}
				}
			: {}),
		...(def.integrations ? { integrations: def.integrations } : {})
	} as CollectionBehaviorFromDef<S, N, TDef>;
}
