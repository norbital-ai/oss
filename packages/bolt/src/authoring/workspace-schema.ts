import type { FacilityName } from '@norbital-ai/bolt-protocol';
import { Schema } from 'effect';
import type { AutomationDeclaration } from './automations-schema.js';
import { CONVERSATION_TRANSPORTS } from '@norbital-ai/bolt-protocol';
import type { EnvoyDefinition } from './contracts-schema.js';
import type { ChannelDeclaration } from './channels-schema.js';
import type { IntegrationDeclaration } from './integrations-schema.js';
import type { ModelExclusion, ModelIndex, ModelEmbedding } from './models-schema.js';
import type { CollectionInputSelection } from './collection-schema.js';
import type {
	CollectionSimilarityIndex,
	CollectionWriteContract
} from '@norbital-ai/std/collection';

/**
 * `uuid` is its own member rather than a flavour of `string`.
 *
 * Every record is keyed by `id uuid`, so a column that points at one has to be `uuid` too:
 * a foreign key planned as `text` cannot be compared with the key it references, and the relation
 * `EXISTS` join the where compiler emits — `"leave_requests"."employment_id" = "employments"."id"` —
 * fails outright with `operator does not exist: text = uuid`. The migration generator reads the
 * authored Drizzle builder and has always rendered `uuid`; only the schema plan flattened it, so a
 * Bolt-provisioned database and a lineage-provisioned one disagreed on every foreign key.
 */
export type ScalarType = 'string' | 'uuid' | 'number' | 'boolean' | 'instant' | 'json';
type FieldType = ScalarType | 'reference';

interface ReferenceTargetDefinition {
	/** Stable discriminator exposed to application code. */
	readonly tag: string;
	/** Collection whose platform `id` column this arm references. */
	readonly collection: string;
	/** Generated nullable UUID column backing this arm. */
	readonly storageColumn: string;
}

interface ReferenceFieldDefinition {
	readonly targets: ReadonlyArray<ReferenceTargetDefinition>;
	readonly onDelete: 'restrict' | 'cascade' | 'set null';
}

export interface FieldDefinition<TType extends FieldType = FieldType> {
	readonly type: TType;
	readonly required: boolean;
	readonly indexed: boolean;
	/** Whether the database owns this field as the table's primary key. */
	readonly primaryKey?: boolean;
	/** Whether that index is a unique one. Only meaningful alongside `indexed`. */
	readonly unique?: boolean;
	/** Inline SQL for a `generatedAlwaysAs` column; the database computes it and nothing writes it. */
	readonly generated?: string;
	/**
	 * The PostgreSQL type the authored column builder declares, when the description was recovered
	 * from one.
	 *
	 * `type` above answers what a value *is* to queries, masking and the client catalog, where
	 * `integer`, `numeric` and `double precision` are all usefully one kind. DDL is the other
	 * question, and collapsing them there is not a simplification but a data loss: the schema plan
	 * rendered every `number` as `double precision`, so `component_entries.amount` — payroll money —
	 * was created as binary floating point, while the migration lineage created the same column
	 * `numeric` from the same builder. Whichever ran first won, and on a database provisioned from
	 * nothing that is always the plan.
	 *
	 * Carried alongside `type` rather than by widening `ScalarType`, because the two questions have
	 * different answers and one value cannot hold both. Absent for a hand-written `field.*`
	 * definition, which never had a builder to read, so the plan keeps its scalar mapping for those.
	 */
	readonly sqlType?: string;
	/**
	 * The column's DEFAULT, already rendered as the SQL literal the DDL carries.
	 *
	 * Same question as `sqlType` and the same answer for the same reason. `.default('MANUAL')` is
	 * part of the column's shape, and the schema plan had nowhere to put it: it created
	 * `roster_entries.origin` as `text not null` with no default while the migration lineage created
	 * the identical column `text DEFAULT 'MANUAL' NOT NULL`. The plan wins on a database provisioned
	 * from nothing, so every insert that relied on the default — all 2756 seeded roster rows, which
	 * correctly omit the column — was refused.
	 *
	 * Rendered SQL rather than the authored value, because a value cannot be written into DDL without
	 * being rendered, and the two places that would render it are exactly the two that disagreed
	 * about `numeric` and `uuid`. `describeModelColumns` renders it once, through Drizzle's own
	 * parameter mapping and the dialect's own literal escaping, so the plan and the lineage read one
	 * answer. Absent for a hand-written `field.*` definition, which has no builder to read.
	 */
	readonly sqlDefault?: string;
	/** Declared `enums()` members, used by the client catalog and column rendering. */
	readonly values?: ReadonlyArray<string>;
	/** The `custom('<name>')` type this column was declared as, when it was declared as one. */
	readonly customType?: string;
	/** The JSON options passed to `custom('<name>', options)`, used by its schema and renderer. */
	readonly customTypeOptions?: Readonly<Record<string, Schema.Json>>;
	/** Picker precision for an instant or instant range; storage remains full precision. */
	readonly precision?: 'day' | 'minute';
	/**
	 * Explicit search opt-in, authored as `text({ search: true })`.
	 *
	 * Search is opt-in because it decides what a free-text query may reach: a column nobody declared
	 * searchable is never matched, however text-like it is.
	 */
	readonly search?: boolean;
	/**
	 * The upload types authored as `file({ mimeTypes })`.
	 *
	 * The column holds the file value inline. This metadata reaches the upload surface and the
	 * manifest; it does not change the JSON value the database stores.
	 */
	readonly mimeTypes?: ReadonlyArray<string>;
	/** Whether this JSON column was authored with `file()`. */
	readonly file?: boolean;
	/** Whether it was authored with `file({ multiple: true })`. */
	readonly fileMultiple?: boolean;
	/** Polymorphic-reference metadata. The logical value remains one `{ kind, id }` handle. */
	readonly reference?: ReferenceFieldDefinition;
}

interface FieldOptions {
	readonly required?: boolean;
	readonly indexed?: boolean;
	/**
	 * Makes the column's index unique — one row per value.
	 *
	 * Needed wherever an upsert conflicts on the column rather than on the key: `on conflict`
	 * requires a unique index to conflict against, and without one the statement does not
	 * degrade, it fails. `user.email` is the case that forced this — the write that
	 * admits a workspace's first administrator is an upsert on the address, made before that
	 * person exists.
	 */
	readonly unique?: boolean;
	/**
	 * The column's DEFAULT, as the SQL literal the DDL carries — see `sqlDefault` above.
	 *
	 * A builder-authored model gets this from the builder. A runtime-owned collection is these
	 * `field.*` calls and had no way to say it, so `required: true` rendered `not null` with no
	 * default and every insert that correctly omits the column was refused. That is the same
	 * failure `roster_entries.origin` had, one layer up.
	 */
	readonly sqlDefault?: string;
}

const isBoolean = Schema.is(Schema.Boolean);
const isString = Schema.is(Schema.String);
const isTriggerShape = Schema.is(
	Schema.Union([Schema.Record(Schema.String, Schema.Unknown), Schema.Array(Schema.Unknown)])
);

/** Owns make field behavior at the authoring boundary so validation and typed semantics stay consistent for every caller. */
const makeField =
	<TType extends ScalarType>(type: TType) =>
	(options: FieldOptions = {}): FieldDefinition<TType> => {
		const required = options.required ?? false;
		const indexed = options.indexed ?? false;
		if (typeof required !== 'boolean') {
			throw new TypeError(`Field ${type} required flag must be boolean.`);
		}
		if (!isBoolean(indexed)) {
			throw new TypeError(`Field ${type} indexed flag must be boolean.`);
		}
		const unique = options.unique ?? false;
		if (!isBoolean(unique)) {
			throw new TypeError(`Field ${type} unique flag must be boolean.`);
		}
		if (unique && !indexed) {
			throw new TypeError(`Field ${type} cannot be unique without being indexed.`);
		}
		return Object.freeze({
			type,
			required,
			indexed,
			...(unique ? { unique } : {}),
			...(options.sqlDefault === undefined ? {} : { sqlDefault: options.sqlDefault })
		});
	};
/**
 * `uuid` is here because a column that references another collection has to be one.
 *
 * Every collection is keyed by `id uuid`, so a foreign key into one is `uuid` too — and a
 * `text` column planned in its place is the `operator does not exist: text = uuid` the where compiler
 * hits when it renders the join it planned. Authored models get this type from their builder; a
 * runtime-owned collection is `field.*` calls and had no way to say it.
 */
export const field = {
	string: makeField('string'),
	number: makeField('number'),
	boolean: makeField('boolean'),
	instant: makeField('instant'),
	json: makeField('json'),
	uuid: makeField('uuid')
};

/** Compiler-derived lexical search facts carried to the runtime. */
interface CollectionSearchDefinition {
	/** The authored `search: true` fields, sorted for stable DDL and ranking. */
	readonly fields: ReadonlyArray<string>;
	readonly documentColumn: 'search_document';
}

/** Model embedding declaration plus the platform columns settle maintains. */
interface CollectionEmbeddingDefinition extends ModelEmbedding {
	readonly vectorColumn: 'record_embedding';
	readonly embeddedAtColumn: 'embedded_at';
	readonly sourceFingerprintColumn: 'record_embedding_fingerprint';
}

export interface CollectionDefinition<Fields extends Readonly<Record<string, FieldDefinition>>> {
	readonly name: string;
	readonly fields: Fields;
	readonly history: boolean;
	/** Compiled expression used to title a record in collection surfaces. */
	readonly recordLabel?: string;
	/**
	 * What the collection is, and the icon a host surface lists it under.
	 *
	 * Both are `defineModel` metadata, declared by 60 and 56 template models between them and read by
	 * nothing: they had no key on this interface to land in, so `renderArtifact` had nowhere to lift
	 * them to and `workspace.manifest` had nothing to project.
	 */
	readonly description?: string;
	readonly icon?: string;
	/**
	 * The `defineModel` metadata's EXCLUDE constraints, carried through because the schema plan is the
	 * only thing that can render them: Drizzle has no entity for an exclusion, so unlike an index they
	 * cannot travel as part of the compiled table.
	 */
	readonly exclusions?: ReadonlyArray<ModelExclusion>;
	/** Database indexes declared by the model, including compound and partial indexes. */
	readonly indexes?: ReadonlyArray<ModelIndex>;
	/**
	 * One platform-maintained record embedding, when the model declares one.
	 *
	 * Carried on the definition rather than derived at each reader, for the reason `exclusions` is:
	 * the schema plan renders the column and its index, and the runtime write path decides what to
	 * send the model — two consumers that must agree on one declaration.
	 */
	readonly embedding?: CollectionEmbeddingDefinition;
	/** Lexical search metadata derived from the same model flags that generated its indexes. */
	readonly search?: CollectionSearchDefinition;
	/** Workspace-relative path of the authored model, so a host surface can link to its source. */
	readonly sourcePath?: string;
	/** The declared write contract, when the collection declares one. */
	readonly write?: CompiledCollectionWrite;
}

interface CollectionOptions<Fields extends Readonly<Record<string, FieldDefinition>>> {
	readonly name: string;
	readonly fields: Fields;
	readonly history?: boolean;
	readonly description?: string;
	readonly icon?: string;
	readonly exclusions?: ReadonlyArray<ModelExclusion>;
	readonly indexes?: ReadonlyArray<ModelIndex>;
}

/** Names one side of an authored relationship foreign key. */
interface RelationEndpoint {
	readonly collection: string;
	readonly column: string;
}

/** One `r.one` / `r.many` edge emitted from `+relationship.ts` into the workspace artifact. */
export interface RelationDefinition {
	readonly name: string;
	readonly source: string;
	readonly target: string;
	readonly cardinality: 'one' | 'many';
	readonly from?: RelationEndpoint;
	readonly to?: RelationEndpoint;
	/**
	 * Whether the parent owns this row outright, so deleting it deletes this one.
	 *
	 * Declared by wrapping the relation in `cascade(...)`. That wrapper existed and did nothing: the
	 * relation parser tolerated the call and stripped it, nothing carried a flag, and every foreign
	 * key in every workspace was emitted `NO ACTION`. So a payroll run could not be deleted once it
	 * had written a payslip — which is the documented way to release the settlement locks it holds
	 * over attendance — and a declaration that reads as meaningful meant nothing at all.
	 */
	readonly cascade?: boolean;
	/** Deleting the target clears this relation's key (`ON DELETE SET NULL`). */
	readonly setNull?: boolean;
	/** This key's existence check defers to commit (`DEFERRABLE INITIALLY DEFERRED`). */
	readonly deferrable?: boolean;
}

/** The renderer vocabulary retained from the authored column builder. */
export type FieldPresentationKind =
	| 'text'
	| 'phone'
	| 'enum'
	| 'integer'
	| 'numeric'
	| 'boolean'
	| 'instant'
	| 'instant_range'
	| 'uuid'
	| 'geolocation'
	| 'file'
	| 'json'
	| 'money'
	| 'reference'
	| string;

export interface CompiledFieldDefinition extends FieldDefinition {
	readonly presentationKind: FieldPresentationKind;
	/** PostgreSQL array storage declared through a Drizzle builder's `.array()` modifier. */
	readonly array?: true;
	/**
	 * Physical NOT NULL state, including generated columns that are never required mutation input.
	 * `required` remains the write-contract fact; migration compilation consumes this one.
	 */
	readonly databaseNotNull?: true;
}

/**
 * The declared write contract of one collection, compiled from its `+collection.ts`.
 *
 * Serializable projection only: the caller-facing selections build the runtime decode, and the
 * notification channel names build the manifest. The live transform and message/recipient
 * builders ride in `AuthoredRuntime.collections`.
 */
export interface CompiledCollectionWrite {
	readonly create?: CollectionInputSelection;
	readonly update?: CollectionInputSelection;
	readonly delete?: true;
	/** Rule channel names per lifecycle event, in declaration order. */
	readonly notifications?: Readonly<Partial<Record<string, ReadonlyArray<string>>>>;
	readonly hasTransform: boolean;
	/** The declared similarity indexes, functions dropped: what the catalog and the planner need. */
	readonly similarity?: ReadonlyArray<CollectionSimilarityIndex>;
}

export interface CompiledCollection extends CollectionDefinition<
	Readonly<Record<string, CompiledFieldDefinition>>
> {
	readonly sourcePath: string;
}

interface CustomTypeReference {
	readonly collection: string;
	readonly field: string;
	readonly name: string;
}

interface CompiledSkillPackage {
	readonly name: string;
	readonly description: string;
	readonly digest: string;
	/** Authored `SKILL.md` body. The capability index stores the digest; the artifact workspace carries this. */
	readonly body: string;
	readonly files: ReadonlyArray<{
		readonly path: string;
		readonly sha256: string;
		readonly byteLength: number;
	}>;
}

export interface EnvironmentReference {
	readonly env: string;
}

export interface PersonalSecretReference {
	readonly personalSecret: string;
}

/** Declarative data accepted from one `src/capabilities/mcp/+<name>.ts` module. */
export const McpRegistrationDefinition = Schema.Struct({
	endpoint: Schema.Union([
		Schema.String.check(Schema.isPattern(/^https?:\/\//)),
		Schema.Struct({ env: Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9_]*$/)) })
	]),
	authentication: Schema.optionalKey(
		Schema.Union([
			Schema.Struct({ env: Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9_]*$/)) }),
			Schema.Struct({
				personalSecret: Schema.NonEmptyString.check(Schema.isMaxLength(128))
			})
		])
	)
});
export interface McpRegistrationDefinition extends Schema.Schema.Type<
	typeof McpRegistrationDefinition
> {}

interface CompiledMcpRegistration {
	readonly name: string;
	readonly digest: string;
	readonly protocol: '2026-07-28';
	readonly transport: Readonly<{
		readonly kind: 'streamable-http';
		readonly endpoint: string | EnvironmentReference;
	}>;
	readonly authentication?: EnvironmentReference | PersonalSecretReference;
}

export interface CompiledTenantCapabilities {
	readonly skills: ReadonlyArray<CompiledSkillPackage>;
	readonly mcp: ReadonlyArray<CompiledMcpRegistration>;
}

/** Canonical build-time semantics for one authored workspace. */
export interface CompiledAuthoring {
	readonly collections: ReadonlyArray<CompiledCollection>;
	readonly relationships: ReadonlyArray<RelationDefinition>;
	readonly customTypeReferences: ReadonlyArray<CustomTypeReference>;
	readonly capabilities: CompiledTenantCapabilities;
}

type CollectionCatalogRelation = Readonly<{
	readonly name: string;
	readonly target: string;
	readonly cardinality: 'one' | 'many';
}>;

export interface CollectionCatalogField {
	readonly name: string;
	readonly kind: string;
	readonly array?: boolean;
	readonly nullable: boolean;
	/** A column with a DEFAULT: a create may leave it unset. */
	readonly defaulted?: boolean;
	readonly readOnly?: boolean;
	readonly search?: boolean;
	readonly values?: ReadonlyArray<string>;
	readonly currencies?: ReadonlyArray<string>;
	readonly precision?: 'day' | 'minute';
	readonly mimeTypes?: ReadonlyArray<string>;
	readonly relation?: CollectionCatalogRelation;
}

export interface CollectionCatalogEntry {
	readonly name: string;
	readonly recordLabel?: string;
	/** The declared write contract, absent for a read-only collection. */
	readonly write?: CollectionWriteContract;
	/** The collection declares a platform embedding: `/semantic` is a real command here. */
	readonly semantic?: true;
	/** The declared similarity indexes: one `/<name>` command each. */
	readonly similarity?: ReadonlyArray<CollectionSimilarityIndex>;
	readonly fields: ReadonlyArray<CollectionCatalogField>;
	readonly relationships: ReadonlyArray<
		CollectionCatalogRelation & {
			readonly cascade?: true;
			readonly setNull?: true;
			readonly deferrable?: true;
		}
	>;
}
/** Owns collection behavior at the authoring boundary so validation and typed semantics stay consistent for every caller. */
export const collection = <const Fields extends Readonly<Record<string, FieldDefinition>>>(
	options: CollectionOptions<Fields>
): CollectionDefinition<Fields> => {
	const name = options.name.trim();
	if (name === '') {
		throw new TypeError('Collection name cannot be empty.');
	}
	for (const fieldName of Object.keys(options.fields)) {
		if (fieldName.trim() === '') {
			throw new TypeError(`Collection ${name} contains an empty field name.`);
		}
	}
	return Object.freeze({ ...options, name, history: options.history ?? true });
};

/**
 * An envoy in the workspace definition: exactly what the author wrote in `src/envoys/+<name>.ts`,
 * plus the one fact the module cannot state about itself — the file's name.
 *
 * It extends the authored definition rather than restating a field list, because restating one is
 * how the two drifted apart. This declaration used to ask `audience: 'direct' | 'group' | 'both'`
 * while the authored definition asked `audience: 'public' | 'authenticated'`, and those are not the
 * same question: the first is what shape of conversation is carried, the second is who may reach it.
 * Reach is the one that survives, on two grounds. It is the axis the only consumer tests —
 * `conversation-selector.ts` routes a public envoy's threads to the admin inbox and keeps them off
 * every member's — and the shape question is already asked, more precisely, by `groupMessages`,
 * which also says how a group message triggers a turn. `both` could not express that.
 *
 * There is no `agent` field. It used to carry a back-pointer whose value was always the one agent
 * the compiler synthesized; an envoy *is* the agent now, so there is nothing left to point at.
 */
interface EnvoyDeclaration extends EnvoyDefinition {
	readonly name: string;
}
/**
 * The reserved name, refused at authoring time rather than dropped at render time.
 *
 * `conversation-selector.ts` uses `web` as the selector's own entry for the web agent's threads, so
 * an envoy called `web` would be silently swallowed by the tab that is already there. Refusing it
 * here is the difference between a build error naming the file and a channel that never appears.
 */
export const WEB_AGENT_NAME = 'web';
/** Owns envoy behavior at the authoring boundary so validation and typed semantics stay consistent for every caller. */
export const envoy = (declaration: EnvoyDeclaration): EnvoyDeclaration => {
	const name = declaration.name.trim();
	if (name === '') throw new TypeError('Envoy name cannot be empty.');
	if (name === WEB_AGENT_NAME) {
		throw new TypeError(
			`Envoy "${WEB_AGENT_NAME}" is reserved: the web agent already occupies that name in the conversation selector, so an envoy called "${WEB_AGENT_NAME}" would never be reachable. Name it after what it is for.`
		);
	}
	if (declaration.channel.trim() === '') throw new TypeError(`Envoy ${name} requires a channel.`);
	if (!['public', 'authenticated'].includes(declaration.audience)) {
		throw new TypeError(`Envoy ${name} has an unsupported audience.`);
	}
	if (declaration.policies.length === 0) {
		throw new TypeError(
			`Envoy ${name} names no policies, so every turn on it would hold no authority at all. Name the policies it may act under.`
		);
	}
	if (!['enabled', 'disabled'].includes(declaration.delegation)) {
		throw new TypeError(`Envoy ${name} requires delegation to be "enabled" or "disabled".`);
	}
	if (declaration.task.trim() === '') throw new TypeError(`Envoy ${name} requires a task.`);
	return Object.freeze({
		...declaration,
		name,
		task: declaration.task.trim(),
		policies: Object.freeze([...declaration.policies])
	});
};
export type { PrivateEnvReference, HttpConnection } from './contracts-schema.js';

/** The MCP server and remote tool behind one entry in the agent's ordinary tool registry. */
export const McpToolRoute = Schema.Struct({
	server: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]*$/), Schema.isMaxLength(64)),
	url: Schema.String.check(Schema.isPattern(/^https?:\/\//)),
	tool: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]+$/), Schema.isMaxLength(128))
});
export interface McpToolRoute extends Schema.Schema.Type<typeof McpToolRoute> {}

/** A tool as the MCP 2026-07-28 `tools/list` contract describes it. */
const McpToolDefinition = Schema.Union([
	Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]+$/), Schema.isMaxLength(128)),
	Schema.Struct({
		name: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]+$/), Schema.isMaxLength(128)),
		description: Schema.optionalKey(Schema.NonEmptyString),
		inputSchema: Schema.optionalKey(
			Schema.JsonObject.check(
				Schema.makeFilter(
					(schema) =>
						schema['type'] === 'object' || 'an MCP tool input schema must have type "object"'
				)
			)
		)
	})
]);

const mcpToolName = (tool: Schema.Schema.Type<typeof McpToolDefinition>): string =>
	isString(tool) ? tool : tool.name;

/** One compiler-discovered MCP v2 server. Its filename owns its name. */
const McpServerDefinition = Schema.Struct({
	url: McpToolRoute.fields.url,
	description: Schema.optionalKey(Schema.NonEmptyString),
	tools: Schema.Array(McpToolDefinition).check(
		Schema.isNonEmpty(),
		Schema.makeFilter((tools) => {
			const names = tools.map(mcpToolName);
			return new Set(names).size === names.length || 'an MCP server cannot declare a tool twice';
		})
	)
});
interface McpServerDefinition extends Schema.Schema.Type<typeof McpServerDefinition> {}

/** One compiled workspace Skill, including discovery metadata and the on-demand body. */
export const SkillDeclaration = Schema.Struct({
	description: Schema.optionalKey(Schema.NonEmptyString),
	name: Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), Schema.isMaxLength(64)),
	body: Schema.NonEmptyString
});
export interface SkillDeclaration extends Schema.Schema.Type<typeof SkillDeclaration> {}

export interface ToolDeclaration {
	readonly name: string;
	readonly description: string;
	readonly command: string;
	/** MCP supplies the JSON Schema its tool accepts; local authored tools validate in their handler. */
	readonly inputSchema?: Schema.JsonObject;
	/** Present only for a remote MCP tool. Execution still enters through this same declaration. */
	readonly mcp?: McpToolRoute;
}

/**
 * Compiles an authored server into the agent's one tool registry.
 *
 * A server is not a second execution or authorization registry. Each allowlisted remote tool becomes
 * the same `ToolDeclaration` a platform or workspace tool uses, with an MCP route attached. Policy
 * grants still name the server, while invocation resolves the exact offered declaration by tool name.
 */
const describeMcpServer = (name: string, definition: unknown): ReadonlyArray<ToolDeclaration> => {
	const server = Schema.decodeUnknownSync(McpServerDefinition)(definition);
	const serverName = Schema.decodeUnknownSync(McpToolRoute.fields.server)(name);
	const defaultDescription = (tool: string) =>
		server.description === undefined
			? `${serverName} MCP tool ${tool}`
			: `${server.description} — ${tool}`;
	return server.tools.map((declared) => {
		const tool = isString(declared)
			? { name: declared, description: defaultDescription(declared) }
			: {
					name: declared.name,
					description: declared.description ?? defaultDescription(declared.name),
					inputSchema: declared.inputSchema
				};
		return {
			name: `${serverName}:${tool.name}`,
			description: tool.description,
			command: 'mcp:tools/call',
			inputSchema: tool.inputSchema ?? { type: 'object', additionalProperties: true },
			mcp: { server: serverName, url: server.url, tool: tool.name }
		};
	});
};

/** Merges authored and MCP tools once, refusing names that would make dispatch ambiguous. */
export const agentTools = (
	authored: ReadonlyArray<ToolDeclaration>,
	servers: Readonly<Record<string, unknown>>
): ReadonlyArray<ToolDeclaration> => {
	const combined = [
		...authored,
		...Object.entries(servers).flatMap(([name, definition]) => describeMcpServer(name, definition))
	];
	const names = combined.map(({ name }) => name);
	if (new Set(names).size !== names.length) {
		throw new TypeError('Workspace agent capabilities contain duplicate tool names.');
	}
	return Object.freeze(combined);
};

/** Builds a schema-checked skill descriptor at the compiler's file boundary. */
export const describeSkill = (name: string, body: string): SkillDeclaration =>
	Schema.decodeUnknownSync(SkillDeclaration)({ name, body });
/** Owns tool behavior at the authoring boundary so validation and typed semantics stay consistent for every caller. */
export const tool = (declaration: ToolDeclaration): ToolDeclaration => {
	if (!/^[a-z][a-z0-9_.-]*$/.test(declaration.name)) {
		throw new TypeError(`Tool name "${declaration.name}" is invalid.`);
	}
	if (declaration.description.trim() === '')
		throw new TypeError(`Tool ${declaration.name} requires a description.`);
	if (declaration.command.trim() === '')
		throw new TypeError(`Tool ${declaration.name} requires a command.`);
	return Object.freeze({
		...declaration,
		description: declaration.description.trim(),
		command: declaration.command.trim()
	});
};
export interface RuntimePolicyGrant {
	readonly collection: string;
	readonly action: 'read' | 'create' | 'update' | 'delete' | 'history';
	readonly where?: Readonly<Record<string, unknown>>;
	readonly fields?: ReadonlyArray<string>;
	/** Additional linking collections; compiler-derived predicate edges remain authoritative. */
	readonly dependencies?: ReadonlyArray<string>;
	readonly authorization?: unknown;
	readonly approval?: unknown;
}

/**
 * A policy as the runtime reads it: the authored file, plus the name its filename gave it.
 *
 * `name` is here and not on `PolicyDefinition`, and the asymmetry is the whole fix. The authored
 * file states no name at all — the compiler reads it off the filename and attaches it here — so
 * there is no second spelling to drift. A display-cased `name:` used to compile and match nothing at
 * run time, in five of six workspaces.
 *
 * `capabilities` and `limits` arrive normalized: `describePolicy` fills the four capability lists
 * and folds a policy's own rate rules into one map, so every consumer reads one shape rather than
 * guessing at absence.
 */
export interface PolicyDeclaration {
	readonly name: string;
	readonly description?: string;
	readonly effect?: 'allow' | 'deny';
	readonly actions?: ReadonlyArray<string>;
	/**
	 * Selects the runtime's own system policy, and nothing an author writes should carry it.
	 *
	 * Matched against `subject.system`, which only `SystemPrincipal.systemSubject` mints — after a
	 * gateway signature verifies. It replaces a `roles` array that selected the same policy by the
	 * string `colony-system`: forgeable by any row that spelled it, and guarded only by a filter that
	 * stripped the string back out of every projected subject.
	 *
	 * A policy is otherwise selected by its own `name`, matched against the policies its holders
	 * name — a team in `+teams.ts`, an envoy declaration, an automation declaration. There is no
	 * second way to name one.
	 */
	readonly system?: boolean;
	/**
	 * Selects the runtime-owned workspace-administration policy.
	 *
	 * This policy enumerates platform controls such as identity and secrets. Authored collection,
	 * app and agent access is instead the trusted administrator bypass at the access boundary, which
	 * explicit team preview clears before evaluation. Authored policies cannot set this flag.
	 */
	readonly administrator?: boolean;
	/**
	 * Selects every subject that signed in, and nothing an author writes should carry it either.
	 *
	 * `PolicyDefinition` — the type an `access/policies/+<name>.ts` is checked against — exposes
	 * neither this nor `system`, so the only declarations that can carry one are the runtime's own in
	 * `BUILT_IN_POLICIES`. It exists because `SYSTEM_READ_POLICY` grants what a workspace's queries
	 * need of the runtime's own collections, and there is no holder for it: a policy name only
	 * reaches a subject through a team, an envoy or an automation, and asking twenty templates to
	 * each declare a team naming `bolt.system-collections` would make a promise the runtime makes
	 * depend on every workspace remembering to opt into it.
	 *
	 * It is deliberately *not* "every subject". The host principal carries `system: true` and holds
	 * the two grants `COLONY_SYSTEM_POLICY` enumerates and nothing else, so `subjectHasPolicy`
	 * excludes it here rather than quietly widening it by one collection at a time.
	 */
	readonly authenticated?: boolean;
	/** Apps, tools, MCP servers and skills this policy grants. The only place capability is declared. */
	readonly capabilities?: import('./contracts-schema.js').PolicyCapabilities;
	/**
	 * This policy's own rate rules, keyed by command pattern, with every `key` resolved.
	 *
	 * `PolicyLimits` — the authored shape — lets `key` be omitted and read as `subject`.
	 * `describePolicy` fills it, so everything downstream reads one shape rather than deciding for
	 * itself what an absent key meant.
	 */
	readonly limits?: Readonly<
		Record<string, ReadonlyArray<import('./rate-limits-schema.js').RateLimitRule>>
	>;
	readonly grants?: ReadonlyArray<RuntimePolicyGrant>;
}
/**
 * Owns policy behavior at the authoring boundary so validation and typed semantics stay consistent
 * for every caller.
 *
 * Only the runtime's own `BUILT_IN_POLICIES` call this. An authored policy is a plain object checked
 * against `PolicyDefinition` and named by its file, so there is no factory for it to forget to call
 * and no name for it to restate.
 */
export const policy = (declaration: PolicyDeclaration): PolicyDeclaration => {
	if (declaration.name.trim() === '') throw new TypeError('Policy name cannot be empty.');
	if ((declaration.actions?.length ?? 0) === 0 && (declaration.grants?.length ?? 0) === 0) {
		throw new TypeError(`Policy ${declaration.name} must declare actions or collection grants.`);
	}
	for (const grant of declaration.grants ?? []) {
		if (grant.collection.trim() === '')
			throw new TypeError(`Policy ${declaration.name} contains an empty collection grant.`);
		if (grant.fields !== undefined && new Set(grant.fields).size !== grant.fields.length) {
			throw new TypeError(
				`Policy ${declaration.name} grant ${grant.collection} contains duplicate field masks.`
			);
		}
	}
	return Object.freeze({ ...declaration, name: declaration.name.trim() });
};

export interface AppDeclaration {
	readonly name: string;
	readonly label: string;
}

interface WorkspaceAppDeclaration extends AppDeclaration {
	readonly icon?: string;
	readonly description?: string;
	readonly banner?: string;
	readonly thumbnail?: string;
	/** Kiosk apps render alone: no sidebar, finder, agent trigger, banner or notifications. */
	readonly kiosk?: boolean;
}

/**
 * One entry of the migration lineage, as it travels inside the artifact.
 *
 * `tag` is the `<UTC timestamp>_<name>` directory name, which is both the identity the ledger
 * records and the sort key that fixes application order. `statements` is `migration.sql` already
 * split on `--> statement-breakpoint`, so the runtime never parses SQL: the compiler reads the file
 * once and the host applies what it is given, hand-authored statements included, in file order.
 *
 * The snapshot beside each `migration.sql` is deliberately absent. It is the *generator's* input —
 * the previous shape to diff against — and nothing applies it; carrying it would add megabytes to
 * every artifact for a value the host has no use for.
 */
export interface WorkspaceMigrationEntry {
	readonly tag: string;
	readonly statements: ReadonlyArray<string>;
}

/**
 * A team's authority: the policies its members hold, keyed by the team's name.
 *
 * Names are matched case-insensitively against `team.name` — one rule, everywhere. Today
 * `roles` matched policy names folded while `teams` matched approver names exactly, and the second
 * of those silently produced approvals nobody could decide.
 *
 * The generated `Teams` type in a workspace's `$types` narrows the values to that workspace's own
 * declared policy names, so renaming or deleting a policy fails the build here rather than quietly
 * emptying somebody's authority.
 */
type TeamsDeclaration = Readonly<Record<string, ReadonlyArray<string>>>;

export interface WorkspaceDefinition {
	readonly name: string;
	readonly version: string;
	readonly collections: ReadonlyArray<
		CollectionDefinition<Readonly<Record<string, FieldDefinition>>>
	>;
	readonly relations: ReadonlyArray<RelationDefinition>;
	/**
	 * Authored custom-type definitions, keyed by declared name.
	 *
	 * Held as `unknown` because a definition's `schema` is a Standard Schema from whichever library
	 * the author uses; the runtime reads it through `~standard` and never depends on the library.
	 */
	readonly customTypes?: Readonly<Record<string, unknown>>;
	/** The `+env.ts` declaration: which environment variables this workspace expects, never values. */
	readonly environment?: import('./environment-schema.js').EnvironmentSpec;
	/**
	 * The `src/+ratelimits.ts` declaration: how often this workspace will admit each class of
	 * command.
	 *
	 * On the workspace rather than in a host's configuration because the facts a real limit is
	 * written in terms of — which command, whose subject, which tenant — are facts only the workspace
	 * and the runtime have. A host at the edge sees an IP, and behind a reverse proxy it does not
	 * reliably see even that.
	 */
	readonly rateLimits?: import('./rate-limits-schema.js').RateLimitSpec;
	readonly apps: ReadonlyArray<WorkspaceAppDeclaration>;
	readonly policies: ReadonlyArray<PolicyDeclaration>;
	/**
	 * The `src/+teams.ts` declaration: which policies each named team holds.
	 *
	 * **Authority is declared; membership is a row.** A `team` row carries a name, a parent and
	 * a description, and an operator edits it from a dashboard without a deploy — because who is on
	 * which team changes constantly. What a team may *do* is this map, compiled into the release,
	 * because a row that granted a policy would be a privilege escalation performed with an `update`
	 * statement, in a place no diff and no type check can see.
	 *
	 * The two are bound by name. A team row whose name is absent here is inert: it holds no
	 * policies, it still works as an approval target, and a deploy that drops a team therefore
	 * removes its authority without orphaning any member.
	 *
	 * Absent — a workspace that declares no teams — means nobody holds any policy through
	 * membership, which is the correct answer for a workspace that has not said otherwise.
	 */
	readonly teams?: TeamsDeclaration;
	/**
	 * The workspace's shared system prompt — the whole of `src/+agents.md`.
	 *
	 * It is the system message of *every* agent turn, web and envoy alike: what the collections mean,
	 * what the company does, house rules for tone and escalation. An envoy's `task` is its own standing
	 * instruction on top of it. Workspace context is shared; purpose is per-envoy.
	 *
	 * It replaces `src/+agent.ts`, which was the only place a workspace could say any of this and which
	 * five of six workspaces did not have — so every externally reachable agent in the realm ran the
	 * synthesized placeholder "You are the <name> workspace agent.", unscoped.
	 */
	readonly prompt: string;
	/**
	 * Every tool this workspace authored, as `src/capabilities/tools/+<name>.ts` files.
	 *
	 * Authoring one offers it to nobody. A tool reaches a turn only when a policy the subject holds
	 * names it under `capabilities.tools`, which is what makes adding a tool file a change that
	 * widens no existing holder.
	 */
	readonly tools: ReadonlyArray<ToolDeclaration>;
	/** Runtime Skill declarations; shared package bytes are named by the release capability index. */
	readonly skills: ReadonlyArray<SkillDeclaration>;
	readonly automations: ReadonlyArray<AutomationDeclaration>;
	readonly channels: ReadonlyArray<ChannelDeclaration>;
	readonly envoys: ReadonlyArray<EnvoyDeclaration>;
	readonly integrations: ReadonlyArray<IntegrationDeclaration>;
	readonly requiredFacilities: ReadonlyArray<FacilityName>;
	/**
	 * The workspace's `.norbital/migrations` lineage, oldest first.
	 *
	 * It rides the definition rather than the bundle manifest because the manifest is a
	 * `bolt-protocol` schema the host decodes: adding a field there makes an artifact undecodable by
	 * every host older than the change, for data no host-side code reads. The lineage is only ever
	 * read by `WorkspaceSchema.migrate`, which already holds the definition.
	 */
	readonly migrations?: ReadonlyArray<WorkspaceMigrationEntry>;
	/** Compiler-generated identity of the workspace's mutation-visible schema. */
	readonly schemaFingerprint?: string;
}

/** Accepts an authored workspace before `relations` is normalized to an array. */
type WorkspaceDraft = Omit<WorkspaceDefinition, 'relations'> & {
	readonly relations?: ReadonlyArray<RelationDefinition>;
};

/** Owns workspace behavior at the authoring boundary so validation and typed semantics stay consistent for every caller. */
export const workspace = (definition: WorkspaceDraft): WorkspaceDefinition => {
	if (definition.name.trim() === '') throw new TypeError('Workspace name cannot be empty.');
	if (definition.version.trim() === '')
		throw new TypeError(`Workspace ${definition.name} requires a version.`);
	const registries = [
		definition.collections,
		definition.apps,
		definition.policies,
		definition.tools,
		definition.skills,
		definition.automations,
		definition.channels,
		definition.envoys,
		definition.integrations
	];
	for (const registry of registries) {
		const names = registry.map(({ name }) => name);
		if (new Set(names).size !== names.length)
			throw new TypeError(`Workspace ${definition.name} contains duplicate declarations.`);
	}
	const envoyChannels = new Set<string>();
	for (const declared of definition.envoys) {
		const channel = definition.channels.find(({ name }) => name === declared.channel);
		if (channel === undefined)
			throw new TypeError(`Envoy ${declared.name} speaks on channel ${declared.channel}, which is not declared in src/channels.`);
		if (!CONVERSATION_TRANSPORTS.includes(channel.transport))
			throw new TypeError(`Envoy ${declared.name}: channel ${channel.name} is ${channel.transport}, which carries no conversation.`);
		if (envoyChannels.has(channel.name))
			throw new TypeError(`Channel ${channel.name} has more than one envoy; one consumer per channel.`);
		envoyChannels.add(channel.name);
	}
	if (new Set(definition.requiredFacilities).size !== definition.requiredFacilities.length) {
		throw new TypeError(`Workspace ${definition.name} contains duplicate required facilities.`);
	}
	return Object.freeze({
		...definition,
		name: definition.name.trim(),
		version: definition.version.trim(),
		relations: Object.freeze([...(definition.relations ?? [])])
	});
};
/** Owns app behavior at the authoring boundary so validation and typed semantics stay consistent for every caller. */
export const app = (declaration: WorkspaceAppDeclaration): WorkspaceAppDeclaration => {
	const name = declaration.name.trim();
	const label = declaration.label.trim();
	if (!/^[a-z][a-z0-9_/-]*$/.test(name)) {
		throw new TypeError(`Application name "${declaration.name}" is invalid.`);
	}
	if (label === '') {
		throw new TypeError(`Application ${name} requires a visible label.`);
	}
	return Object.freeze({
		name,
		label,
		...(declaration.icon === undefined ? {} : { icon: declaration.icon }),
		...(declaration.description === undefined ? {} : { description: declaration.description }),
		...(declaration.banner === undefined ? {} : { banner: declaration.banner }),
		...(declaration.thumbnail === undefined ? {} : { thumbnail: declaration.thumbnail }),
		...(declaration.kiosk === undefined ? {} : { kiosk: declaration.kiosk })
	});
};
