import type { Component } from 'svelte';
import type { ManifestRelationship } from '@norbital-ai/platform-utils/manifest/types';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { z } from 'zod';
import { systemWorkspace } from '../schema/system-workspace.js';
import type { SchemaBuilder } from '../schema/define-schema.js';
import type { AnySchema } from '../schema/types.js';
import type { AnyCustomTypeDefinition } from '../custom-type.js';
import {
	isCollectionBehavior,
	type AnyCollectionBehavior,
	type CollectionBehaviorDef,
	type CollectionBehaviorFromDef,
	type CreateInput,
	type UpdateInput
} from '../schema/collection-behavior.js';
import type { TableName } from '../schema/types.js';
import { deriveManifestRelationships } from './derive-relationships.js';
import type { AgentAutomationSpec, AutomationDeclaration } from '../automations/automations.js';
import type { AgentToolDefinition } from '../automations/agent-tools.js';
import type { PolicyDeclaration } from '../policies/policies.js';
import type { ChannelDefinition } from '../channels/channels.js';
import type { HandlerDefinition } from '../automations/handlers.js';
import type { InvokeMap } from './invoke-api-types.js';
import type { WorkspaceClient } from '$lib/ui/state/workspace-client.js';
import type { Skill } from '$lib/skills/types.js';
import type { CollectionType } from '@norbital-ai/platform-utils/collection';
import type { BeforeApi } from './hook-api.js';
import type { WorkspaceEnvDeclaration } from '../env.js';
import {
	buildCollectionsRecord,
	buildTypedWorkspaceClient,
	toRuntimeBehaviors
} from './workspace-runtime.js';
import type {
	HttpConnection,
	PrivateEnvReference,
	RegisteredIntegration
} from '../integrations/integrations.js';

type InvokeMapInput = InvokeMap;

export type WorkspaceAppDef = {
	readonly name: string;
	readonly description: string;
	readonly icon: string | null;
	/** Child key used as this application group's landing destination. */
	readonly defaultChild?: string | null;
	readonly thumbnail?: string | null;
	readonly banner?: string | null;
	readonly component?: Component<Record<string, never>> | Record<string, WorkspaceAppDef>;
	readonly config?: {
		readonly whitelist?: { readonly origins?: readonly string[] };
	};
};

export type WorkspaceMeta = {
	readonly name?: string;
	readonly version?: string;
	readonly description?: string;
};

export type WorkspaceRelationshipMap = Readonly<Record<string, ManifestRelationship>>;

export type WorkspaceCollectionEntry<S extends AnySchema> = {
	[K in TableName<S>]: CollectionBehaviorFromDef<S, K, CollectionBehaviorDef<S, K>>;
}[TableName<S>];

export type DefineWorkspaceInput<
	S extends AnySchema,
	TCollections extends readonly WorkspaceCollectionEntry<S>[]
> = {
	readonly collections: TCollections;
	readonly automations?: readonly AutomationDeclaration[];
	/** `src/+agent.ts` — the permissions and prompt for the Pod-owned interactive agent. */
	readonly agent?: AgentAutomationSpec;
	readonly agentTools?: Readonly<Record<string, AgentToolDefinition>>;
	/** `src/skills` compiled to data — markdown the agent loads on demand, not code it calls. */
	readonly skills?: readonly Skill[];
	/** Policy definitions declared in `src/policies`, keyed by filename. */
	readonly policies?: Readonly<Record<string, PolicyDeclaration>>;
	/** Channel declarations from `src/channels`, keyed by filename. */
	readonly channels?: Readonly<Record<string, ChannelDefinition>>;
	readonly apps?: Readonly<Record<string, WorkspaceAppDef>>;
	/**
	 * `src/custom-types` — carried so the manifest can name them and say what they hold.
	 *
	 * The registry already binds these to columns; this is a second reference on purpose, because the
	 * schema builder erases everything but the resolved zod schema and the description would have no
	 * way out of the bundle otherwise.
	 */
	readonly customTypes?: Readonly<Record<string, AnyCustomTypeDefinition>>;
	readonly invoke?: InvokeMapInput;
	readonly meta?: WorkspaceMeta;
	readonly seed?: import('@norbital-ai/platform-utils/seed/plan').WorkspaceSeedDefinition;
	/** `src/+env.ts` — the names this workspace needs from its host, never the values. */
	readonly env?: WorkspaceEnvDeclaration;
};

type CollectionsRecord<S extends AnySchema, T extends readonly WorkspaceCollectionEntry<S>[]> = {
	readonly [K in T[number]['name']]: Extract<T[number], { readonly name: K }>;
};

export type RegisteredWorkspaceState = {
	readonly inputSchemas: Record<string, { readonly create: z.ZodType; readonly update: z.ZodType }>;
	readonly pipelines: Record<string, Record<string, unknown>>;
	readonly automations: Record<string, unknown>;
	readonly agent: AgentAutomationSpec | null;
	readonly agentTools: Record<string, AgentToolDefinition>;
	readonly skills: readonly Skill[];
	readonly policies: Record<string, PolicyDeclaration>;
	readonly channels: Record<string, ChannelDefinition>;
	readonly apps: Record<string, WorkspaceAppDef>;
	readonly remotes: Record<string, HandlerDefinition>;
	readonly integrationBindings: Record<string, RegisteredIntegrationRuntimeBinding>;
};

export type RegisteredIntegrationRuntimeBinding =
	| {
			readonly direction: 'receive';
			readonly input?: z.ZodType;
			readonly collection: string;
			readonly systemEvent?: string;
	  }
	| {
			readonly direction: 'send';
			readonly on: string | Readonly<Record<string, unknown>>;
			readonly transform?: (
				ctx: { readonly output: unknown },
				api: BeforeApi
			) => unknown | Promise<unknown>;
	  };

export type WorkspaceInstance<
	S extends AnySchema,
	TCollections extends readonly WorkspaceCollectionEntry<S>[],
	TInvoke extends InvokeMap = InvokeMap
> = {
	readonly schema: S;
	readonly collections: CollectionsRecord<S, TCollections>;
	readonly tables: Readonly<Record<string, PgTable>>;
	readonly relations: S['relations'];
	readonly relationships: WorkspaceRelationshipMap;
	readonly customTypes?: Readonly<Record<string, AnyCustomTypeDefinition>>;
	readonly meta?: WorkspaceMeta;
	readonly seed?: DefineWorkspaceInput<S, TCollections>['seed'];
	readonly env?: { readonly public?: Readonly<Record<string, string>> };
	readonly secrets?: Readonly<
		Record<string, { readonly description: string; readonly required?: boolean }>
	>;
	readonly integrations: readonly RegisteredIntegration[];
	readonly api: WorkspaceClient<S, TInvoke>;
	readonly registered: RegisteredWorkspaceState;
};

/** Concrete collection row/create/update types carried from a tenant workspace into shared UI. */
export type WorkspaceCollectionRegistry<TWorkspace> =
	TWorkspace extends WorkspaceInstance<infer S, infer TCollections, infer _TInvoke>
		? {
				readonly [TName in TCollections[number]['name']]: CollectionType<
					S['tables'][TName]['$inferSelect'],
					CreateInput<S, TName, Extract<TCollections[number], { readonly name: TName }>['def']>,
					UpdateInput<S, TName, Extract<TCollections[number], { readonly name: TName }>['def']>
				>;
			}
		: never;

function systemTables(): Record<string, PgTable> {
	return Object.fromEntries(
		Object.entries(systemWorkspace).map(([name, entry]) => [name, entry.table])
	);
}

function validateCollections(schema: AnySchema, collections: readonly unknown[]): void {
	const seen = new Set<string>();
	for (const behavior of collections) {
		if (!isCollectionBehavior(behavior)) {
			throw new Error('defineWorkspace collections must be w.collection(...) declarations');
		}
		if (!(behavior.name in schema.tables)) {
			throw new Error(
				`Collection "${behavior.name}" is not a table on this schema — check defineSchema tables`
			);
		}
		if (seen.has(behavior.name)) {
			throw new Error(`Duplicate collection "${behavior.name}" in defineWorkspace`);
		}
		seen.add(behavior.name);
	}
}

function validateJsonValue(value: unknown, path: string, seen: Set<object>): void {
	if (value == null || typeof value === 'string' || typeof value === 'boolean') return;
	if (typeof value === 'number' && Number.isFinite(value)) return;
	if (typeof value !== 'object') throw new Error(`${path} must contain only JSON values`);
	if (seen.has(value)) throw new Error(`${path} must not contain circular references`);
	seen.add(value);
	if (Array.isArray(value)) {
		value.forEach((entry, index) => validateJsonValue(entry, `${path}[${index}]`, seen));
	} else {
		for (const [key, entry] of Object.entries(value)) {
			validateJsonValue(entry, `${path}.${key}`, seen);
		}
	}
	seen.delete(value);
}

function absoluteUrl(baseUrl: string, path: string): string {
	return new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

function registerConnectionSecret(
	reference: PrivateEnvReference,
	requirements: Record<string, { description: string; required?: boolean }>
) {
	if (!requirements[reference.env]) {
		const declared = Object.keys(requirements).sort();
		throw new Error(
			`Integration references undeclared private environment key "${reference.env}". ` +
				`Add it to the \`private\` block of src/+env.ts.` +
				(declared.length > 0 ? ` Declared: ${declared.join(', ')}.` : '')
		);
	}
	return { type: 'secret' as const, name: reference.env };
}

/**
 * The connection's credential as request headers — the value stays a reference.
 *
 * `Bearer ` travels as a `prefix` on the reference rather than as a parallel map, because it is one
 * header value: the scheme is public, the token is not, and splitting them across two maps produced
 * a manifest the schema rejected.
 */
function connectionSecretHeaders(
	connection: HttpConnection,
	requirements: Record<string, { description: string; required?: boolean }>
) {
	const authentication = connection.authentication;
	if (!authentication) return {};
	if (authentication.type === 'bearer') {
		return {
			secretHeaders: {
				authorization: {
					...registerConnectionSecret(authentication.token, requirements),
					prefix: 'Bearer '
				}
			}
		};
	}
	return {
		secretHeaders: {
			[authentication.header]: registerConnectionSecret(authentication.value, requirements)
		}
	};
}

/**
 * Refuse two collections that claim the same integration name with different endpoints.
 *
 * Compared by value rather than by object identity. Identity was the rule until it made an HTTP
 * destination unbuildable from the filesystem: two collections in two files cannot share one object
 * unless a third file exists to hold it, so declaring a connection where the doc says to declare it —
 * in `+integrations.ts` — always failed as "unregistered". By value, the same connection written
 * twice is the same connection, and a genuine disagreement still fails naming the integration.
 */
function sameConnection(left: HttpConnection, right: HttpConnection): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function registerIntegrations(
	behaviors: readonly AnyCollectionBehavior[],
	privateEnv: Readonly<Record<string, { readonly description: string }>> | undefined
): {
	integrations: readonly RegisteredIntegration[];
	secrets: Readonly<Record<string, { description: string; required?: boolean }>> | undefined;
	integrationBindings: Record<string, RegisteredIntegrationRuntimeBinding>;
} {
	const requirements: Record<string, { description: string; required?: boolean }> = {
		...(privateEnv ?? {})
	};
	const integrationBindings: Record<string, RegisteredIntegrationRuntimeBinding> = {};
	const emittedSystemEvents = new Set<string>();
	const integrationConnections = new Map<string, HttpConnection | undefined>();
	const definitions = new Map<
		string,
		{
			connection?: Record<string, unknown>;
			inbound: Record<string, unknown>;
			outbound: Record<string, unknown>;
		}
	>();

	function definitionFor(name: string, connection: HttpConnection | undefined) {
		const existing = definitions.get(name);
		if (existing) return existing;
		const authentication = connection?.authentication;
		const definition: {
			connection?: Record<string, unknown>;
			inbound: Record<string, unknown>;
			outbound: Record<string, unknown>;
		} = {
			...(connection
				? {
						connection: {
							type: 'http',
							baseUrl: connection.baseUrl,
							...(authentication
								? {
										authentication:
											authentication.type === 'bearer'
												? {
														type: 'bearer',
														token: registerConnectionSecret(authentication.token, requirements)
													}
												: {
														type: 'header',
														header: authentication.header,
														value: registerConnectionSecret(authentication.value, requirements)
													}
									}
								: {})
						}
					}
				: {}),
			inbound: {},
			outbound: {}
		};
		definitions.set(name, definition);
		return definition;
	}

	for (const behavior of behaviors) {
		for (const [integrationName, integration] of Object.entries(behavior.integrations ?? {})) {
			const connection = integration.connection;
			if (integrationConnections.has(integrationName)) {
				const previous = integrationConnections.get(integrationName);
				const agrees =
					previous === connection ||
					(previous != null && connection != null && sameConnection(previous, connection));
				if (!agrees) {
					throw new Error(
						`Integration "${integrationName}" must use the same connection across collections`
					);
				}
			}
			integrationConnections.set(integrationName, connection);
			const definition = definitionFor(integrationName, connection);
			for (const [bindingName, binding] of Object.entries(integration.receive ?? {})) {
				const bindingId = `${behavior.name}.receive.${bindingName}`;
				let origin: Record<string, unknown>;
				if (binding.systemEvent) {
					origin = {
						type: 'system-event',
						event: binding.systemEvent.event
					};
				} else if (binding.webhook) {
					// A narrowing nobody can evaluate is worse than none: it reads as a guarantee and
					// filters nothing. Refusing here means the author learns at build time, not from a
					// binding quietly accepting every event type the provider ever sends.
					if (binding.webhook.events && !binding.webhook.eventType) {
						throw new Error(
							`Collection "${behavior.name}" integration "${integrationName}" receive binding "${bindingName}" narrows \`events\` but declares no \`eventType\`; add \`eventType: { header: '...' }\` or \`eventType: { path: '...' }\` so Pod can tell what arrived`
						);
					}
					origin = {
						type: 'webhook',
						events: binding.webhook.events,
						eventType: binding.webhook.eventType,
						authentication: binding.webhook.authentication
							? {
									type: 'hmac-sha256',
									secret: registerConnectionSecret(
										binding.webhook.authentication.secret,
										requirements
									),
									signatureHeader: binding.webhook.authentication.signatureHeader,
									timestamp: binding.webhook.authentication.timestamp
								}
							: undefined,
						eventId: binding.webhook.eventIdHeader
							? { header: binding.webhook.eventIdHeader }
							: undefined
					};
				} else if (binding.pull && connection) {
					origin = {
						type: 'api-pull',
						schedule: binding.pull.schedule,
						url: absoluteUrl(connection.baseUrl, binding.pull.path),
						method: binding.pull.method,
						cursorQuery: binding.pull.cursorQuery,
						nextCursorHeader: binding.pull.nextCursorHeader,
						...connectionSecretHeaders(connection, requirements)
					};
				} else {
					throw new Error(
						`Collection "${behavior.name}" integration "${integrationName}" receive binding "${bindingName}" must declare a system event, webhook, or pull with a connection`
					);
				}
				definition.inbound[bindingId] = {
					collection: behavior.name,
					pipeline: 'import',
					origin
				};
				integrationBindings[`${integrationName}:${bindingId}`] = {
					direction: 'receive',
					input: binding.input,
					collection: behavior.name,
					systemEvent: binding.systemEvent?.event
				};
			}
			for (const [bindingName, binding] of Object.entries(integration.send ?? {})) {
				if (binding.request && !connection) {
					throw new Error(
						`Collection "${behavior.name}" integration "${integrationName}" send binding "${bindingName}" requires a connection`
					);
				}
				const bindingId = `${behavior.name}.send.${bindingName}`;
				const destination = binding.systemEvent
					? { type: 'system-event' as const, event: binding.systemEvent.event }
					: connection && binding.request
						? {
								type: 'api' as const,
								url: absoluteUrl(connection.baseUrl, binding.request.path),
								method: binding.request.method,
								headers: binding.request.headers,
								...connectionSecretHeaders(connection, requirements)
							}
						: undefined;
				if (!destination) {
					throw new Error(
						`Collection "${behavior.name}" integration "${integrationName}" send binding "${bindingName}" must declare a system event or an HTTP request with a connection`
					);
				}
				definition.outbound[bindingId] = {
					collection: behavior.name,
					pipeline: 'export',
					trigger: 'collection-events',
					destination
				};
				if (destination.type === 'system-event') emittedSystemEvents.add(destination.event);
				const transform = binding.transform;
				integrationBindings[`${integrationName}:${bindingId}`] = {
					direction: 'send',
					on: binding.on,
					transform:
						typeof transform === 'function'
							? (ctx, api) => Reflect.apply(transform, undefined, [ctx, api])
							: undefined
				};
			}
		}
	}

	assertSystemEventsAreReachable(integrationBindings, emittedSystemEvents);

	const integrations = [...definitions].map(([name, definition]) => ({ name, definition }));
	for (const integration of integrations)
		validateJsonValue(integration.definition, `Integration "${integration.name}"`, new Set());
	assertDeclaredSecretsAreReferenced(requirements, integrations);
	return {
		integrations,
		secrets: Object.keys(requirements).length > 0 ? requirements : undefined,
		integrationBindings
	};
}

/** Every `{ type: 'secret', name }` reference reachable in a compiled integration definition. */
function referencedSecretNames(value: unknown, found: Set<string>): Set<string> {
	if (value == null || typeof value !== 'object') return found;
	if (Array.isArray(value)) {
		for (const entry of value) referencedSecretNames(entry, found);
		return found;
	}
	const record = value as Record<string, unknown>;
	if (record.type === 'secret' && typeof record.name === 'string') found.add(record.name);
	for (const entry of Object.values(record)) referencedSecretNames(entry, found);
	return found;
}

/**
 * Refuse a private-env key nothing references.
 *
 * `manifest.secrets` is what a host provisions against, so an unreferenced key asks an operator for a
 * credential no code path will ever read — and, worse, hides the real mistake, which is almost always
 * a reference spelled differently from the declaration. The opposite direction already fails in
 * `registerConnectionSecret`; this closes the loop so the two sets have to match exactly.
 */
export function assertDeclaredSecretsAreReferenced(
	requirements: Readonly<Record<string, unknown>>,
	integrations: readonly RegisteredIntegration[]
): void {
	const declared = Object.keys(requirements);
	if (declared.length === 0) return;
	const referenced = referencedSecretNames(
		integrations.map((integration) => integration.definition),
		new Set<string>()
	);
	const unused = declared.filter((name) => !referenced.has(name)).sort();
	if (unused.length === 0) return;
	throw new Error(
		`src/+env.ts declares private environment key(s) nothing references: ${unused.join(', ')}. ` +
			'Reference them from an integration connection or webhook signature, or remove them — a ' +
			'declared secret becomes something the host is asked to provision.'
	);
}

/**
 * Refuse a receive binding waiting on a system event nothing emits.
 *
 * The two halves are matched by exact string at dispatch, so a typo on either side produced no
 * matching bindings, no error, and no record — the integration simply never fired. That is the worst
 * failure shape in the surface, and the name is a cross-reference, so it can be checked once the whole
 * registry is built. Startup is the right moment: it names the binding rather than leaving a silence
 * to be noticed weeks later.
 */
export function assertSystemEventsAreReachable(
	integrationBindings: Record<string, RegisteredIntegrationRuntimeBinding>,
	emitted: ReadonlySet<string>
): void {
	const unreachable = Object.entries(integrationBindings).flatMap(([key, binding]) =>
		binding.direction === 'receive' && binding.systemEvent && !emitted.has(binding.systemEvent)
			? [{ key, event: binding.systemEvent }]
			: []
	);
	if (unreachable.length === 0) return;
	const known = [...emitted].sort();
	throw new Error(
		unreachable
			.map(
				({ key, event }) =>
					`Integration binding "${key}" receives system event "${event}", which no send binding emits.` +
					(known.length > 0 ? ` Declared events: ${known.join(', ')}.` : ' No events are declared.')
			)
			.join('\n')
	);
}

export function defineWorkspace<
	S extends AnySchema,
	const TCollections extends readonly WorkspaceCollectionEntry<S>[],
	const TInvoke extends InvokeMapInput = InvokeMapInput
>(
	schema: SchemaBuilder<S>,
	input: DefineWorkspaceInput<S, TCollections> & { readonly invoke?: TInvoke }
): WorkspaceInstance<S, TCollections, TInvoke> {
	validateCollections(schema, input.collections);

	const behaviorList = toRuntimeBehaviors(input.collections);
	const behaviorMap = Object.fromEntries(behaviorList.map((behavior) => [behavior.name, behavior]));
	const collectionsRecord = buildCollectionsRecord(input.collections);

	const remotes: Record<string, HandlerDefinition> = { ...(input.invoke ?? {}) };
	const tables: Record<string, PgTable> = { ...systemTables() };
	const inputSchemas: RegisteredWorkspaceState['inputSchemas'] = {};
	const pipelines: Record<string, Record<string, unknown>> = {};

	for (const behavior of behaviorList) {
		tables[behavior.name] = behavior.table;
		inputSchemas[behavior.name] = behavior.inputs;
		const pipelineEntry: Record<string, unknown> = {};
		if (behavior.export) pipelineEntry.export = behavior.export;
		if (behavior.import) pipelineEntry.import = behavior.import;
		if (Object.keys(pipelineEntry).length > 0) {
			pipelines[behavior.name] = pipelineEntry;
		}
	}

	const registration = registerIntegrations(behaviorList, input.env?.private);

	const relationships = deriveManifestRelationships(schema.relations);

	const automations: Record<string, unknown> = {};
	for (const decl of input.automations ?? []) {
		automations[decl.name] = { trigger: decl.trigger, spec: decl.spec };
	}

	const registered: RegisteredWorkspaceState = {
		inputSchemas,
		pipelines,
		automations,
		agent: input.agent ?? null,
		agentTools: { ...(input.agentTools ?? {}) },
		skills: [...(input.skills ?? [])],
		policies: { ...(input.policies ?? {}) },
		channels: { ...(input.channels ?? {}) },
		apps: { ...(input.apps ?? {}) },
		remotes,
		integrationBindings: registration.integrationBindings
	};

	const api = buildTypedWorkspaceClient<S, TInvoke>(schema, behaviorMap, remotes);

	const ws: WorkspaceInstance<S, TCollections, TInvoke> = {
		schema,
		collections: collectionsRecord,
		tables,
		relations: schema.relations,
		relationships,
		customTypes: input.customTypes,
		meta: input.meta,
		seed: input.seed,
		env: input.env
			? {
					public: Object.fromEntries(
						Object.entries(input.env.public ?? {}).map(([name, requirement]) => [
							name,
							requirement.default ?? ''
						])
					)
				}
			: undefined,
		secrets: registration.secrets,
		integrations: registration.integrations,
		api,
		registered
	};

	return ws;
}

/** Erased workspace shape used only by compiler-generated runtime assembly. */
export type RuntimeWorkspaceInstance = {
	readonly schema: AnySchema;
	readonly collections: Readonly<Record<string, unknown>>;
	readonly tables: Readonly<Record<string, PgTable>>;
	readonly relations: AnySchema['relations'];
	readonly relationships: WorkspaceRelationshipMap;
	readonly customTypes?: Readonly<Record<string, AnyCustomTypeDefinition>>;
	readonly meta?: WorkspaceMeta;
	readonly seed?: import('@norbital-ai/platform-utils/seed/plan').WorkspaceSeedDefinition;
	readonly env?: { readonly public?: Readonly<Record<string, string>> };
	readonly integrations: readonly RegisteredIntegration[];
	readonly secrets?: Readonly<
		Record<string, { readonly description: string; readonly required?: boolean }>
	>;
	readonly registered: RegisteredWorkspaceState;
};

/**
 * Assemble a generated workspace without replaying its schema generics. Tenant
 * hooks, pipelines, and remotes are checked in their authored modules.
 */
export function defineRuntimeWorkspace(schema: unknown, input: unknown): RuntimeWorkspaceInstance {
	return defineWorkspace(
		schema as SchemaBuilder<AnySchema>,
		input as DefineWorkspaceInput<AnySchema, readonly WorkspaceCollectionEntry<AnySchema>[]>
	) as RuntimeWorkspaceInstance;
}
