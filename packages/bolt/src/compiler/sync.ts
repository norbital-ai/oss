import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { Effect, Schema } from 'effect';
import { PROTOCOL_VERSION } from '@norbital-ai/bolt-protocol';
import {
	describeSkill,
	type RelationDefinition,
	type SkillDeclaration,
	type WorkspaceMigrationEntry
} from '../authoring/workspace-schema.js';
import {
	BOLT_TENANT_REQUEST_PREFIX,
	BOLT_TENANT_STATIC_PREFIX,
	WORKSPACE_ENTRY_FILE_NAME
} from './client-entry.js';
import { appCapabilityNames } from './compiler.js';
import { extractAppMetadata, extractGroupMetadata } from './app-metadata.js';
import {
	extractCollectionCatalog,
	extractModelFields,
	extractRelationships,
	type CollectionCatalogEntry
} from './model-fields.js';

const boltPackageRoot = fileURLToPath(new URL('../..', import.meta.url));

/** Tests file presence without blocking the compiler's Effect-owned workflow. */
const fileExists = (path: string): Effect.Effect<boolean> =>
	Effect.tryPromise(() => access(path)).pipe(
		Effect.as(true),
		Effect.catch(() => Effect.succeed(false))
	);

/** Resolves a compiler alias to workspace `src` when present, otherwise the published `build` file. */
const boltEntry = (sourcePath: string, publishedPath: string): Effect.Effect<string> => {
	const source = join(boltPackageRoot, sourcePath);
	return fileExists(source).pipe(
		Effect.map((sourceExists) => (sourceExists ? source : join(boltPackageRoot, publishedPath)))
	);
};

export type SyncResult = Readonly<{
	readonly workspaceRoot: string;
	readonly collectionNames: ReadonlyArray<string>;
	readonly appNames: ReadonlyArray<string>;
	readonly toolNames: ReadonlyArray<string>;
	readonly envoyNames: ReadonlyArray<string>;
	readonly automationNames: ReadonlyArray<string>;
	readonly mcpServerNames: ReadonlyArray<string>;
	readonly artifactPath: string;
	readonly staticAssetCount: number;
}>;

type PackageMetadata = Readonly<{
	readonly name: string;
	readonly version: string;
	readonly description: string;
}>;

const PackageMetadataFile = Schema.Struct({
	name: Schema.optionalKey(Schema.NonEmptyString),
	version: Schema.optionalKey(Schema.NonEmptyString),
	description: Schema.optionalKey(Schema.NonEmptyString)
});

const I18nMessagesFile = Schema.Record(Schema.String, Schema.String);

type I18nCatalogs = Readonly<{
	readonly en: Readonly<Record<string, string>>;
	readonly zh: Readonly<Record<string, string>>;
}>;

type RenderAuthoringTypesInput = Readonly<{
	readonly collections: ReadonlyArray<string>;
	readonly apps: ReadonlyArray<string>;
	readonly policies: ReadonlyArray<string>;
	readonly functions: ReadonlyArray<string>;
	readonly tools: ReadonlyArray<string>;
	readonly envoys: ReadonlyArray<string>;
	readonly mcpServers: ReadonlyArray<string>;
	readonly skills: ReadonlyArray<string>;
	readonly datatypes: ReadonlyArray<string>;
	readonly automations: ReadonlyArray<string>;
	/** The import specifier for `src/access/+teams.ts`, relative to `.norbital/generated/`. */
	readonly teamsImport: string | undefined;
}>;

type RenderedAppGroup = Readonly<{
	readonly name: string;
	readonly label?: string;
	readonly description?: string;
	readonly icon?: string;
	readonly defaultChild?: string;
}>;

type RenderedAppMetadata = Readonly<{
	readonly label?: string;
	readonly icon?: string;
	readonly description?: string;
	readonly banner?: string;
	readonly thumbnail?: string;
}>;

type ResolvedMutationRelation = Readonly<{
	readonly column: string | undefined;
	readonly parentColumn: string | undefined;
	readonly cascade: boolean;
}>;

const endpointColumn = (relation: RelationDefinition, collection: string): string | undefined => {
	if (relation.from?.collection === collection) return relation.from.column;
	if (relation.to?.collection === collection) return relation.to.column;
	return undefined;
};

const uniqueInverseRelation = (
	relation: RelationDefinition,
	relations: ReadonlyArray<RelationDefinition>
): RelationDefinition | undefined => {
	let inverse: RelationDefinition | undefined;
	for (const candidate of relations) {
		if (candidate.source !== relation.target || candidate.target !== relation.source) continue;
		if (candidate.cardinality !== 'one') continue;
		if (endpointColumn(candidate, relation.target) === undefined) continue;
		if (endpointColumn(candidate, relation.source) === undefined) continue;
		if (inverse !== undefined) return undefined;
		inverse = candidate;
	}
	return inverse;
};

const resolveMutationRelation = (
	relation: RelationDefinition,
	relations: ReadonlyArray<RelationDefinition>
): ResolvedMutationRelation => {
	if (relation.cardinality === 'one') {
		return {
			column: relation.from?.collection === relation.source ? relation.from.column : undefined,
			parentColumn: endpointColumn(relation, relation.target),
			cascade: relation.cascade === true
		};
	}

	const directChildColumn = endpointColumn(relation, relation.target);
	const directParentColumn = endpointColumn(relation, relation.source);
	if (directChildColumn !== undefined && directParentColumn !== undefined) {
		return {
			column: directChildColumn,
			parentColumn: directParentColumn,
			cascade: relation.cascade === true
		};
	}

	const inverse = uniqueInverseRelation(relation, relations);
	return {
		column: inverse === undefined ? undefined : endpointColumn(inverse, relation.target),
		parentColumn: inverse === undefined ? undefined : endpointColumn(inverse, relation.source),
		cascade: relation.cascade === true || inverse?.cascade === true
	};
};

type EmbeddedAsset = Readonly<{
	readonly path: string;
	readonly contentType: string;
	readonly sha256: string;
	readonly base64: string;
}>;

/**
 * Everything one artifact is rendered from, named.
 *
 * Exported because the call sites that most need the names are the tests: each one builds a
 * workspace shaped for the one thing it asserts about, and every role it does not care about used
 * to be a bare `[]` in a run of twelve indistinguishable ones.
 *
 * The optional fields are the discovered files a workspace may simply not have. They are optional
 * rather than defaulted-positional so that omitting one still reads as "this workspace declares no
 * teams" at the call site, instead of as a gap somebody has to count.
 */
type RenderArtifactInput = Readonly<{
	readonly metadata: PackageMetadata;
	readonly collections: ReadonlyArray<{
		readonly name: string;
		readonly path: string;
		readonly sourcePath: string;
		readonly hooksPath?: string;
		readonly fields: Readonly<
			Record<
				string,
				{ readonly type: string; readonly required: boolean; readonly indexed: boolean }
			>
		>;
	}>;
	readonly relations: ReadonlyArray<RelationDefinition>;
	readonly apps: ReadonlyArray<{
		readonly name: string;
		readonly label: string;
		readonly icon?: string;
		readonly description?: string;
		readonly banner?: string;
		readonly thumbnail?: string;
	}>;
	readonly policies: ReadonlyArray<string>;
	readonly functions: ReadonlyArray<string>;
	readonly toolFiles: ReadonlyArray<string>;
	readonly envoyFiles: ReadonlyArray<string>;
	readonly automations: ReadonlyArray<string>;
	readonly automationFiles: ReadonlyArray<string>;
	readonly pipelineFiles: ReadonlyArray<string>;
	readonly skills: ReadonlyArray<SkillDeclaration>;
	/** Authored MCP v2 declarations, imported live into the artifact like tools and policies. */
	readonly mcpFiles?: ReadonlyArray<string>;
	/**
	 * `src/+agents.md` — the system message of every agent turn in this workspace.
	 *
	 * Required, and the compiler refuses a workspace without one. There is no placeholder to fall
	 * back to: the placeholder was the defect. `sync.ts` used to synthesize
	 * `"You are the <name> workspace agent."` and five of six workspaces shipped it, including both
	 * of the two whose agents were reachable from outside.
	 */
	readonly prompt: string;
	readonly root: string;
	readonly assets: ReadonlyArray<EmbeddedAsset>;
	readonly customTypeDefinitions: ReadonlyArray<string>;
	readonly migrations: ReadonlyArray<WorkspaceMigrationEntry>;
	/** The workspace's `+integrations.ts` files, one per collection directory that declares one. */
	readonly integrationFiles?: ReadonlyArray<string>;
	/** `+env.ts` at the workspace root, when the workspace declares an environment. */
	readonly environmentFile: string | undefined;
	/** `src/access/+anonymous_limits.ts`, when the workspace bounds its pre-sign-in surface. */
	readonly anonymousLimitFile?: string | undefined;
	/** `src/access/+teams.ts`, when the workspace declares which policies each named team holds. */
	readonly teamsFile?: string | undefined;
}>;

/** Owns compiler discovery, rendering, and artifact emission as one cohesive stateless namespace. */
class WorkspaceCompiler {
	/** Owns read package metadata behavior at the compiler boundary so validation and typed semantics stay consistent for every caller. */
	static readonly readPackageMetadata = (root: string) =>
		Effect.gen(function* () {
			const source = yield* Effect.tryPromise(() => readFile(join(root, 'package.json'), 'utf8'));
			const value = Schema.decodeUnknownSync(Schema.fromJsonString(PackageMetadataFile))(source);
			return {
				name: value.name ?? basename(root),
				version: value.version ?? '0.0.0-local',
				description: value.description ?? 'Bolt workspace'
			};
		});

	/** Owns files under behavior at the compiler boundary so validation and typed semantics stay consistent for every caller. */
	static readonly filesUnder = (root: string) => {
		const walker = {
			visit: (directory: string): Effect.Effect<Array<string>> =>
				Effect.gen(function* () {
					const entries = yield* Effect.tryPromise(() =>
						readdir(directory, { withFileTypes: true })
					).pipe(Effect.catch(() => Effect.succeed<Array<Dirent>>([])));
					const nested = yield* Effect.all(
						entries.map((entry) => {
							const path = join(directory, entry.name);
							return entry.isDirectory() ? walker.visit(path) : Effect.succeed([path]);
						}),
						{ concurrency: 'unbounded' }
					);
					return nested.flat();
				})
		};
		return walker.visit(root);
	};

	/** Owns posix behavior at the compiler boundary so validation and typed semantics stay consistent for every caller. */
	static readonly posix = (path: string): string => path.split(sep).join('/');
	/** Owns source import behavior at the compiler boundary so validation and typed semantics stay consistent for every caller. */
	static readonly sourceImport = (root: string, path: string): string =>
		`../../${WorkspaceCompiler.posix(relative(root, path)).replace(/\.(?:ts|svelte)$/, '.js')}`;
	/** Owns runtime source import behavior at the compiler boundary so validation and typed semantics stay consistent for every caller. */
	static readonly runtimeSourceImport = (root: string, path: string): string =>
		`../../${WorkspaceCompiler.posix(relative(root, path))}`;
	/** Owns quoted union behavior at the compiler boundary so validation and typed semantics stay consistent for every caller. */
	static readonly quotedUnion = (values: ReadonlyArray<string>): string =>
		values.length === 0 ? 'never' : values.map((value) => JSON.stringify(value)).join(' | ');
	/** Owns import lines behavior at the compiler boundary so validation and typed semantics stay consistent for every caller. */
	static readonly importLines = (
		paths: ReadonlyArray<string>,
		root: string,
		prefix: string
	): string =>
		paths
			.map(
				(path, index) =>
					`import ${prefix}${index} from ${JSON.stringify(WorkspaceCompiler.sourceImport(root, path))};`
			)
			.join('\n');

	/** Owns render models behavior at the compiler boundary so validation and typed semantics stay consistent for every caller. */
	static readonly renderModels = (models: ReadonlyArray<string>, root: string): string => {
		const entries = models
			.map((path, index) => `\t${JSON.stringify(basename(dirname(path)))}: model${index}`)
			.join(',\n');
		return `import { defineModels } from '@norbital-ai/bolt/authoring/internals';\n${WorkspaceCompiler.importLines(models, root, 'model')}\n\nexport const models = defineModels({\n${entries}\n});\nexport type Models = typeof models;\n`;
	};

	/** Owns render custom types behavior at the compiler boundary so validation and typed semantics stay consistent for every caller. */
	static readonly renderCustomTypes = (
		definitions: ReadonlyArray<string>,
		root: string
	): string => {
		const entries = definitions
			.map((path, index) => `\t${JSON.stringify(basename(dirname(path)))}: definition${index}`)
			.join(',\n');
		return `import type { CustomTypeOutput } from '@norbital-ai/bolt/authoring';\n${WorkspaceCompiler.importLines(definitions, root, 'definition')}\n\nexport const customTypes = {\n${entries}\n} as const;\nexport type CustomKind = keyof typeof customTypes;\nexport type CustomValue<K extends CustomKind> = CustomTypeOutput<(typeof customTypes)[K]>;\n`;
	};

	/**
	 * Every name one declaration in this workspace may use to reach another, as a union.
	 *
	 * Eleven of them, and eleven is the point. Seven were generated before this and exactly one —
	 * `PolicyName` — had a resolver in `contracts-schema.ts`, so `AgentToolName`, `McpServerName`,
	 * `AppName`, `ChannelName` and `RemoteName` were emitted, declared, and read by nobody. Four more
	 * did not exist at all, and the most expensive of those absences was `TeamName`: `approvers:
	 * ['HR Manger']` compiled and produced an approval nobody could ever decide.
	 *
	 * The rule is now uniform, so an author never has to know which names are checked: **if one
	 * declaration names another, that name is a generated union and a rename fails the build.**
	 *
	 * `AppName` includes both concrete leaves and their directory prefixes because runtime app access
	 * deliberately treats a prefix as a group grant. Keeping those prefixes in the generated union
	 * makes `apps: ['hr_controller']` exact without widening every application capability to `string`.
	 *
	 * `TeamName` is derived from the teams module's own keys rather than from a quoted list, because
	 * the compiler does not evaluate `+teams.ts` — it discovers it. `keyof typeof` reads the keys the
	 * type checker sees, which includes any a scan of the source text would miss. A workspace with no
	 * teams file gets `never`, which is correct: with no team declared, there is no valid approver.
	 */
	static readonly renderAuthoringTypes = (input: RenderAuthoringTypesInput): string => {
		const union = WorkspaceCompiler.quotedUnion;
		const teams =
			input.teamsImport === undefined
				? 'export type TeamName = never;'
				: `import type declaredTeams from ${JSON.stringify(input.teamsImport)};\nexport type TeamName = Extract<keyof typeof declaredTeams, string>;`;
		return [
			teams,
			`export type CollectionName = ${union(input.collections)};`,
			`export type PolicyName = ${union(input.policies)};`,
			`export type AppName = ${union(appCapabilityNames(input.apps))};`,
			`export type ToolName = ${union(input.tools)};`,
			`export type McpServerName = ${union(input.mcpServers)};`,
			`export type SkillName = ${union(input.skills)};`,
			`export type EnvoyName = ${union(input.envoys)};`,
			`export type AutomationName = ${union(input.automations)};`,
			`export type FunctionName = ${union(input.functions)};`,
			`export type DatatypeName = ${union(input.datatypes)};`,
			''
		].join('\n');
	};

	/** Owns render i18n keys behavior at the compiler boundary so validation and typed semantics stay consistent for every caller. */
	static readonly renderI18nKeys = (messages: Readonly<Record<string, string>>): string => {
		const keys = Object.keys(messages).toSorted();
		return keys.length === 0
			? 'export type TenantI18nKeys = string;\n'
			: `export type TenantI18nKeys =\n${keys.map((key) => `\t| ${JSON.stringify(key)}`).join('\n')};\n`;
	};

	/** Owns read i18n messages behavior at the compiler boundary so validation and typed semantics stay consistent for every caller. */
	static readonly readI18nMessages = (root: string) => {
		const readLocale = (locale: 'en' | 'zh'): Effect.Effect<Readonly<Record<string, string>>> =>
			Effect.gen(function* () {
				const path = join(root, 'src', 'i18n', `messages.${locale}.json`);
				const source = yield* Effect.tryPromise(() => readFile(path, 'utf8')).pipe(
					Effect.catch(() => Effect.succeed<string | undefined>(undefined))
				);
				return source === undefined
					? {}
					: Schema.decodeUnknownSync(Schema.fromJsonString(I18nMessagesFile))(source);
			});
		return Effect.gen(function* () {
			const [en, zh] = yield* Effect.all([readLocale('en'), readLocale('zh')] as const);
			return { en, zh };
		});
	};

	/** Owns render i18n messages behavior at the compiler boundary so validation and typed semantics stay consistent for every caller. */
	static readonly renderI18nMessages = (catalogs: I18nCatalogs): string =>
		`export const tenantMessages = ${JSON.stringify({ en: catalogs.en, zh: catalogs.zh })};\n`;

	/** Owns render i18n messages declaration behavior at the compiler boundary so validation and typed semantics stay consistent for every caller. */
	static readonly renderI18nMessagesDeclaration = (): string =>
		`export declare const tenantMessages: {\n\treadonly en: Readonly<Record<string, string>>;\n\treadonly zh: Readonly<Record<string, string>>;\n};\n`;

	/** Owns render collection catalog behavior at the compiler boundary so CollectionTable can read field metadata. */
	static readonly renderCollectionCatalog = (
		entries: ReadonlyArray<CollectionCatalogEntry>
	): string => {
		const catalog = Object.fromEntries(entries.map((entry) => [entry.name, entry]));
		return `export const collectionCatalog = ${JSON.stringify(catalog)};\n`;
	};

	/** Owns render collection catalog declaration behavior at the compiler boundary so validation and typed semantics stay consistent for every caller. */
	static readonly renderCollectionCatalogDeclaration = (): string =>
		`export declare const collectionCatalog: Readonly<Record<string, {\n\treadonly name: string;\n\treadonly recordLabel?: string;\n\treadonly fields: ReadonlyArray<{ readonly name: string; readonly kind: string; readonly nullable: boolean; readonly readOnly?: boolean; readonly search?: boolean; readonly values?: ReadonlyArray<string> }>;\n\treadonly relationships: ReadonlyArray<{ readonly name: string; readonly target: string; readonly cardinality: 'one' | 'many'; readonly cascade?: true }>;\n}>>;\n`;

	/**
	 * The declared relations, as a type.
	 *
	 * `+relationship.ts` reached the DDL — foreign keys and their cascades — and the query prefetch,
	 * and stopped there: `relations` was generated as `Record<never, never>` for every workspace. So
	 * nothing downstream could tell a relation name from a misspelled column, which is what a nested
	 * write has to do before it can be typed at all.
	 *
	 * Keyed by collection, then by the **declared relation name** — the same name `with:` already
	 * takes on the read side. One vocabulary for reaching a related record, whether reading it or
	 * writing it.
	 *
	 * `column` is the foreign key on the *child*, which is what a nested write fills in from the
	 * parent's join column. `parentColumn` makes that other half explicit; the current synchronizer
	 * supports only `id`, so another join is excluded by the generated mutation type rather than
	 * promised and rejected at run time. A relation missing either endpoint carries `never` rather
	 * than a guess.
	 */
	static readonly renderRelationTypes = (relations: ReadonlyArray<RelationDefinition>): string => {
		const byCollection = new Map<string, Array<string>>();
		for (const relation of relations) {
			/**
			 * A nested mutation expands a `many` edge from parent to children, but authored relationship
			 * endpoints live on its inverse `one` edge: the child's foreign key is the `from` endpoint of
			 * `child -> parent`. The two directions may have different declared names, so pairing is by
			 * reversed collections and oriented endpoints; more than one candidate is ambiguous. A few
			 * programmatic definitions put those endpoints directly on `many`, which is equally
			 * unambiguous. Any other shape stays `never`; generated types must not guess.
			 */
			const { column, parentColumn, cascade } = resolveMutationRelation(relation, relations);
			const entry = `\t\treadonly ${JSON.stringify(relation.name)}: { readonly target: ${JSON.stringify(relation.target)}; readonly cardinality: ${JSON.stringify(relation.cardinality)}; readonly column: ${column === undefined ? 'never' : JSON.stringify(column)}; readonly parentColumn: ${parentColumn === undefined ? 'never' : JSON.stringify(parentColumn)}; readonly cascade: ${cascade ? 'true' : 'false'} };`;
			const existing = byCollection.get(relation.source);
			if (existing === undefined) byCollection.set(relation.source, [entry]);
			else existing.push(entry);
		}
		if (byCollection.size === 0) return 'Readonly<Record<never, never>>';
		const blocks = [...byCollection.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(
				([collection, entries]) =>
					`\treadonly ${JSON.stringify(collection)}: {\n${entries.sort().join('\n')}\n\t};`
			);
		return `{\n${blocks.join('\n')}\n}`;
	};

	/** Owns render types behavior at the compiler boundary so validation and typed semantics stay consistent for every caller. */
	static readonly renderTypes = (relations: ReadonlyArray<RelationDefinition> = []): string =>
		`import type { AfterHookApi as CollectionAfterHookApi, BeforeApi, HookApi as CollectionHookApi, SchemaQueryConfig, SchemaQueryRow } from '@norbital-ai/bolt/authoring';\nimport type { InputValuesForTables, MutationInsertFor, TablesForModels } from '@norbital-ai/bolt/authoring/internals';\nimport type { Models } from './models.js';\n\ntype WorkspaceTables = TablesForModels<Models>;\ntype WorkspaceRelations = ${WorkspaceCompiler.renderRelationTypes(relations)};\nexport type WorkspaceSchema = { readonly tables: WorkspaceTables; readonly relations: WorkspaceRelations; readonly inputs: InputValuesForTables<WorkspaceTables> };\nexport type Api = BeforeApi<WorkspaceSchema>;\nexport type HookApi = CollectionHookApi<WorkspaceSchema>;\nexport type AfterHookApi = CollectionAfterHookApi<WorkspaceSchema>;\nexport type WorkspaceRow<N extends keyof WorkspaceSchema['tables'] & string, Cfg extends SchemaQueryConfig<WorkspaceSchema, N> | undefined = undefined> = SchemaQueryRow<WorkspaceSchema, N, Cfg>;\nexport type WorkspaceInsert<N extends keyof WorkspaceSchema['tables'] & string> = MutationInsertFor<WorkspaceSchema, N>;\n`;

	/** Owns render custom augmentation behavior at the compiler boundary so validation and typed semantics stay consistent for every caller. */
	static readonly renderCustomAugmentation = (
		definitions: ReadonlyArray<string>,
		root: string
	): string => {
		const imports = definitions
			.map(
				(path, index) =>
					`import type definition${index} from ${JSON.stringify(WorkspaceCompiler.sourceImport(root, path))};`
			)
			.join('\n');
		const values = definitions
			.map(
				(path, index) =>
					`\t\treadonly ${JSON.stringify(basename(dirname(path)))}: CustomTypeOutput<typeof definition${index}>;`
			)
			.join('\n');
		const options = definitions
			.map(
				(path, index) =>
					`\t\treadonly ${JSON.stringify(basename(dirname(path)))}: CustomTypeFactoryOptions<typeof definition${index}>;`
			)
			.join('\n');
		return `import type { CustomTypeFactoryOptions, CustomTypeOutput } from '@norbital-ai/bolt/authoring';\n${imports}\n\ndeclare module '@norbital-ai/bolt/authoring' {\n\tinterface WorkspaceAuthoringTypes {\n\t\treadonly customTypeValues: {\n${values}\n\t\t};\n\t\treadonly customTypeOptions: {\n${options}\n\t\t};\n\t}\n}\nexport {};\n`;
	};

	/** Owns render collection types behavior at the compiler boundary so validation and typed semantics stay consistent for every caller. */
	static readonly renderCollectionTypes = (name: string): string =>
		`import type { CollectionHooks, CollectionIntegrations, CollectionPipelines } from '@norbital-ai/bolt/authoring';\nimport type { WorkspaceRow, WorkspaceSchema } from '../../../generated/types.js';\nexport type { AfterHookApi, Api, HookApi, WorkspaceRow } from '../../../generated/types.js';\nexport type Row = WorkspaceRow<${JSON.stringify(name)}>;\nexport type RepresentationProps = { readonly record: Row | null; close(): void };\nexport type Hooks<Prepared = void> = CollectionHooks<WorkspaceSchema, ${JSON.stringify(name)}, Prepared>;\nexport type Pipelines = CollectionPipelines<WorkspaceSchema, ${JSON.stringify(name)}>;\nexport type Integrations = CollectionIntegrations<WorkspaceSchema, ${JSON.stringify(name)}>;\n`;

	/** Owns render relationship types behavior at the compiler boundary so validation and typed semantics stay consistent for every caller. */
	static readonly renderRelationshipTypes = (): string =>
		`import type { PlatformRelationshipsFor } from '@norbital-ai/bolt/authoring/internals';\nimport type { Models } from '../../generated/models.js';\nexport type Relationships = PlatformRelationshipsFor<Models>;\n`;

	/**
	 * `src/access/policies/$types.d.ts` — what a policy file is checked against.
	 *
	 * Three levels up rather than two, because policies moved a directory deeper: `access/policies/`
	 * rather than `policies/`. `TeamName` is re-exported because an approval step's `approvers` names
	 * teams and an author writing one wants the union in hand.
	 */
	static readonly renderPolicyTypes = (): string =>
		`import type { PolicyDefinition } from '@norbital-ai/bolt/authoring';\nimport type { WorkspaceSchema } from '../../../generated/types.js';\nexport type { AppName, CollectionName, McpServerName, PolicyName, SkillName, TeamName, ToolName } from '../../../generated/authoring-types.js';\nexport type Policy = PolicyDefinition<WorkspaceSchema>;\n`;

	/** `src/access/$types.d.ts` — the teams map and the pre-sign-in limits are checked against these. */
	static readonly renderAccessTypes = (): string =>
		`export type { PolicyName, TeamName } from '../../generated/authoring-types.js';\nimport type { Teams as TeamsDeclaration } from '@norbital-ai/bolt/authoring';\nexport type Teams = TeamsDeclaration;\n`;

	/** `src/envoys/$types.d.ts` — what an envoy file is checked against. */
	static readonly renderEnvoyTypes = (): string =>
		`import type { EnvoyDefinition } from '@norbital-ai/bolt/authoring';\nexport type { EnvoyName, PolicyName } from '../../generated/authoring-types.js';\nexport type Envoy = EnvoyDefinition;\n`;

	/** `src/automations/$types.d.ts` and `src/functions/$types.d.ts` — the authored-handler surface. */
	static readonly renderHandlerTypes = (): string =>
		`import type { AutomationContext, AutomationTrigger } from '@norbital-ai/bolt/authoring/internals';\nimport type { WorkspaceSchema } from '../../generated/types.js';\nexport type { Api, WorkspaceRow } from '../../generated/types.js';\nexport type { AutomationName, CollectionName, FunctionName, PolicyName, ToolName } from '../../generated/authoring-types.js';\nexport type Trigger = AutomationTrigger<WorkspaceSchema>;\nexport type Scope<T extends Trigger> = AutomationContext<T, WorkspaceSchema>['scope'];\n`;

	/** Owns render custom type renderer behavior at the compiler boundary so validation and typed semantics stay consistent for every caller. */
	static readonly renderCustomTypeRenderer = (definition: string, root: string): string => {
		const definitionImport = `../../../${WorkspaceCompiler.posix(relative(root, definition)).replace(/\.ts$/, '.js')}`;
		// `CustomTypeOutput` rather than an inference helper named from one schema library: it resolves a
		// factory definition the same way and reads the value type off `~standard`, so a renderer states its
		// own value type without the workspace depending on whichever library declared it.
		return `import type { CustomTypeOutput } from '@norbital-ai/bolt/authoring';\nimport type definition from ${JSON.stringify(definitionImport)};\nexport type CollectionField = { readonly name: string; readonly type: string };\nexport type Value = CustomTypeOutput<typeof definition>;\nexport type RendererProps =\n\t| { readonly mode: 'display'; readonly field: CollectionField; readonly value: Value | null }\n\t| { readonly mode: 'edit'; readonly field: CollectionField; readonly value: Value | null; readonly disabled: boolean; onValueChange(value: Value | null): void };\n`;
	};

	/**
	 * The augmentation that makes every generated union reachable from an authored file.
	 *
	 * All eleven, because a union that is generated and not resolved here is a union nothing checks.
	 * Ten share `WorkspaceAuthoringTypes`; `TeamName` uses `WorkspaceTeamAuthoringTypes` so the teams
	 * map may consume `PolicyName` without becoming its own dependency. Adding a union still requires
	 * a generated property and its matching resolver.
	 */
	static readonly renderWorkspaceAuthoring = (): string =>
		`import type { AppName, AutomationName, CollectionName, DatatypeName, EnvoyName, FunctionName, McpServerName, PolicyName, SkillName, TeamName, ToolName } from '../generated/authoring-types.js';\nimport type { WorkspaceSchema } from '../generated/types.js';\ndeclare module '@norbital-ai/bolt/authoring' { interface WorkspaceAuthoringTypes { readonly schema: WorkspaceSchema; readonly collectionName: CollectionName; readonly policyName: PolicyName; readonly appName: AppName; readonly toolName: ToolName; readonly mcpServerName: McpServerName; readonly skillName: SkillName; readonly envoyName: EnvoyName; readonly automationName: AutomationName; readonly functionName: FunctionName; readonly datatypeName: DatatypeName } interface WorkspaceTeamAuthoringTypes { readonly teamName: TeamName } }\nexport {};\n`;

	/** Owns render client runtime declaration behavior at the compiler boundary so validation and typed semantics stay consistent for every caller. */
	static readonly renderClientRuntimeDeclaration = (): string =>
		`declare module 'virtual:bolt/client-runtime' {\n\timport type { CollectionCatalog, SystemClientApi, WorkspaceClientRuntime } from '@norbital-ai/bolt/client-runtime';\n\texport function createBrowserWorkspaceRuntime(): WorkspaceClientRuntime;\n\texport function createWorkspaceApiProxy(runtime: WorkspaceClientRuntime, catalog?: CollectionCatalog): { readonly db: object; readonly invoke: object; readonly collections: object; readonly system: SystemClientApi };\n\texport function startLocalReplica(runtime: WorkspaceClientRuntime, open?: unknown, options?: { readonly accessScope?: string }): Promise<unknown>;\n\texport function switchWorkspaceAccessScope(runtime: WorkspaceClientRuntime, accessScope: string): void;\n}\n`;

	/** Owns render client declaration behavior at the compiler boundary so validation and typed semantics stay consistent for every caller. */
	static readonly renderClientDeclaration = (
		hooks: ReadonlyArray<string>,
		functions: ReadonlyArray<string>,
		root: string
	): string => {
		const hookEntries = hooks
			.map(
				(path) =>
					`\treadonly ${JSON.stringify(basename(dirname(path)))}: typeof import(${JSON.stringify(WorkspaceCompiler.sourceImport(root, path))}).default;`
			)
			.join('\n');
		const invokeEntries = functions
			.map(
				(path) =>
					`\treadonly ${JSON.stringify(basename(path).slice(1, -3))}: typeof import(${JSON.stringify(WorkspaceCompiler.sourceImport(root, path))}).default;`
			)
			.join('\n');
		return `import type { CollectionRegistryFor, InvokeClientApi, PlatformSchema } from '@norbital-ai/bolt/authoring/internals';\nimport type { CollectionMutationValues, SystemClientApi } from '@norbital-ai/bolt/client-runtime';\nimport type { CollectionClient } from '@norbital-ai/std/collection';\nimport type { CollectionSurface } from '@norbital-ai/ui/collection-runtime';\nimport type { CustomTypeRendererMap } from '@norbital-ai/ui/data-renderer';\nimport type { Component } from 'svelte';\nimport type { WorkspaceSchema } from './types.js';\ntype CollectionHooks = {\n${hookEntries}\n};\ntype MutationRegistry<S extends { readonly tables: Readonly<Record<string, { readonly $inferSelect: object; readonly $inferInsert: object }>>; readonly relations: Readonly<Record<string, unknown>> }, Registry> = { readonly [N in keyof Registry]: Registry[N] & { readonly mutation: CollectionMutationValues<S, N & keyof S['tables'] & string> } };\ntype TenantCollections = MutationRegistry<WorkspaceSchema, CollectionRegistryFor<WorkspaceSchema, CollectionHooks>>;\ntype PlatformCollections = MutationRegistry<PlatformSchema, CollectionRegistryFor<PlatformSchema>>;\ntype Collections = TenantCollections & PlatformCollections;\ntype TenantDatabase = { readonly [N in keyof TenantCollections]: CollectionClient<TenantCollections>['db'][N] };\ntype PlatformDatabase = { readonly [N in Exclude<keyof PlatformCollections, keyof TenantCollections>]: CollectionClient<PlatformCollections>['db'][N] };\ntype Invoke = {\n${invokeEntries}\n};\nexport type { WorkspaceRow } from './types.js';\nexport type WorkspaceCollections = Collections;\nexport type WorkspaceMutation<N extends keyof TenantCollections> = TenantCollections[N]['mutation'];\nexport type Client = Omit<CollectionClient<Collections>, 'db'> & { readonly db: TenantDatabase & PlatformDatabase; readonly invoke: InvokeClientApi<Invoke>; readonly system: SystemClientApi };\nexport declare const client: Client;\nexport declare const runtime: import('@norbital-ai/bolt/client-runtime').WorkspaceClientRuntime;\nexport declare const changeAccessScope: (accessScope: string) => void;\nexport declare const startLocalReplica: (runtime: import('@norbital-ai/bolt/client-runtime').WorkspaceClientRuntime, open?: unknown, options?: { readonly accessScope?: string }) => Promise<{ readonly stop: () => void }>;\nexport declare const appLoaders: Readonly<Record<string, () => Promise<Component>>>;\nexport declare const representationLoaders: Readonly<Record<string, () => Promise<NonNullable<CollectionSurface['representation']>>>>;\nexport declare const customTypeRendererLoaders: Readonly<Record<string, () => Promise<CustomTypeRendererMap[string]>>>;\nexport declare const appGroups: Readonly<Record<string, { readonly defaultChild?: string; readonly label?: string; readonly description?: string; readonly icon?: string }>>;\nexport declare const appMeta: Readonly<Record<string, { readonly label?: string; readonly icon?: string; readonly description?: string; readonly banner?: string; readonly thumbnail?: string }>>;\nexport declare const policyNames: ReadonlyArray<string>;\n`;
	};

	/** Owns render client runtime behavior at the compiler boundary so validation and typed semantics stay consistent for every caller. */
	static readonly renderClientRuntime = (
		apps: ReadonlyArray<string>,
		groups: ReadonlyArray<RenderedAppGroup>,
		appMeta: Readonly<Record<string, RenderedAppMetadata>>,
		policies: ReadonlyArray<string>,
		root: string,
		representations: ReadonlyArray<string>,
		customRenderers: ReadonlyArray<string>
	): string => {
		const appNameFrom = (path: string): string =>
			WorkspaceCompiler.posix(relative(join(root, 'src', 'apps'), path))
				.replace(/(^|\/)\+/, '$1')
				.replace(/\.svelte$/, '');
		const loaders = apps
			.map(
				(path) =>
					`\t${JSON.stringify(appNameFrom(path))}: () => import(${JSON.stringify(WorkspaceCompiler.runtimeSourceImport(root, path))}).then((module) => module.default)`
			)
			.join(',\n');
		// Lazy for the same reason apps are: a record sheet is opened for one collection at a time, and
		// eagerly importing twenty-one surfaces would pull every renderer they use into the first paint.
		const representationLoaders = representations
			.map(
				(path) =>
					`\t${JSON.stringify(basename(dirname(path)))}: () => import(${JSON.stringify(WorkspaceCompiler.runtimeSourceImport(root, path))}).then((module) => module.default)`
			)
			.join(',\n');
		const customRendererLoaders = customRenderers
			.map(
				(path) =>
					`\t${JSON.stringify(basename(dirname(path)))}: () => import(${JSON.stringify(WorkspaceCompiler.runtimeSourceImport(root, path))}).then((module) => module.default)`
			)
			.join(',\n');
		const groupEntries = groups
			.map(
				(group) =>
					`\t${JSON.stringify(group.name)}: ${JSON.stringify({
						...(group.defaultChild === undefined ? {} : { defaultChild: group.defaultChild }),
						...(group.label === undefined ? {} : { label: group.label }),
						...(group.description === undefined ? {} : { description: group.description }),
						...(group.icon === undefined ? {} : { icon: group.icon })
					})}`
			)
			.join(',\n');
		return `import './app.css';\n// The workspace stylesheet rides this module, not the entry.\n//\n// Vite links an entry's CSS from the HTML document it generates, and this build generates no\n// document — so a sheet imported by the entry is emitted beside it and never loaded. A sheet\n// imported by a *dynamically* imported chunk is different: Vite's own preload helper inserts the\n// link before the chunk executes. This module is only ever reached through \`import('$bolt/client')\`\n// inside \`mountWorkspace\`, so the supported mechanism applies and nothing has to rewrite chunk\n// text to make the workspace render styled.\nimport { createBrowserWorkspaceRuntime, createWorkspaceApiProxy, startLocalReplica, switchWorkspaceAccessScope } from 'virtual:bolt/client-runtime';\nimport { collectionCatalog } from './collections.js';\nconst runtime = createBrowserWorkspaceRuntime();\nexport const client = createWorkspaceApiProxy(runtime, collectionCatalog);\n// The replica is started by whoever owns its lifetime, never by importing this module.\n//\n// It used to start here, at module scope. But this module is also what a host imports to read\n// \`appLoaders\` — so merely reaching for the app registry opened a database, and it opened one\n// before anybody had signed in: \`sync.provisioning\` answered 401 and the replica gave up on a\n// workspace it would have been allowed to read a moment later. A host that then started its own\n// replica after sign-in got a second engine for the same scope, because starting one is not\n// idempotent.\n//\n// \`startLocalReplica\` is re-exported instead, so the owner starts it once it has a session and can\n// stop it on teardown. PGlite is several megabytes of WebAssembly, so bringing it up after the page\n// is interactive — rather than before first paint — remains the point.\nexport const changeAccessScope = (accessScope) => switchWorkspaceAccessScope(runtime, accessScope);\nexport { runtime, startLocalReplica };\nexport const appLoaders = {\n${loaders}\n};\nexport const representationLoaders = {\n${representationLoaders}\n};\nexport const customTypeRendererLoaders = {\n${customRendererLoaders}\n};\nexport const appGroups = {\n${groupEntries}\n};\nexport const appMeta = ${JSON.stringify(appMeta)};\nexport const policyNames = ${JSON.stringify(policies)};\n`;
	};

	/**
	 * The workspace's stylesheet, generated where the workspace's other generated modules live.
	 *
	 * There is exactly one now. The design system's base sheet was imported by the *host*, which then
	 * had to be taught — through a Vite plugin of its own — to also scan every mounted workspace's
	 * source, because a class only a template used was otherwise never generated and its heatmap
	 * rendered transparent. That only ever worked while the host compiled the templates. The tenant
	 * bundle owns its UI now, so it owns the sheet that styles it, and the host scans nothing.
	 *
	 * The `@source` paths are relative to this file, which always sits at
	 * `<workspace>/.norbital/generated/app.css` — so `../../` is the workspace root and its own
	 * `node_modules`. Every scanned tree is a build output rather than source: `tv()` variant tables
	 * compile to `.js`, and the only `.ts` left in a build is a declaration file, which holds no class.
	 */
	static readonly renderWorkspaceStylesheet = (): string =>
		[
			"@import '@norbital-ai/ui/base.css';",
			'',
			"@source '../../src/**/*.{js,ts,svelte}';",
			"@source '../../node_modules/@norbital-ai/ui/build/**/*.{js,svelte}';",
			"@source '../../node_modules/@norbital-ai/bolt/build/client/ui/**/*.{js,svelte}';",
			'',
			'.bolt-app {',
			'\tmin-height: 100%;',
			'\tdisplay: grid;',
			'\tgrid-template-rows: auto 1fr;',
			'}',
			'',
			'.bolt-header-actions {',
			'\tdisplay: flex;',
			'\talign-items: center;',
			'\tgap: 0.5rem;',
			'}',
			''
		].join('\n');

	/** Owns render tsconfig behavior at the compiler boundary so validation and typed semantics stay consistent for every caller. */
	static readonly renderTsconfig = (): string =>
		JSON.stringify(
			{
				compilerOptions: {
					allowSyntheticDefaultImports: true,
					esModuleInterop: true,
					lib: ['ES2023', 'DOM', 'DOM.Iterable'],
					module: 'ES2022',
					moduleResolution: 'bundler',
					noEmit: true,
					rootDirs: ['../src', './types', '..'],
					paths: {
						'$bolt/*': ['./generated/*'],
						svelte: ['../node_modules/svelte'],
						'svelte/*': ['../node_modules/svelte/*']
					},
					customConditions: ['svelte'],
					skipLibCheck: true,
					strict: true,
					target: 'ES2022',
					types: ['vite/client'],
					resolveJsonModule: true
				},
				include: [
					'../src/**/*.ts',
					'../src/**/*.svelte',
					'./generated/**/*.ts',
					'./types/**/*.d.ts'
				],
				exclude: ['../node_modules', './dist']
			},
			null,
			'\t'
		);

	/** Owns content type behavior at the compiler boundary so validation and typed semantics stay consistent for every caller. */
	static readonly contentType = (path: string): string => {
		if (path.endsWith('.html')) return 'text/html; charset=utf-8';
		if (path.endsWith('.js') || path.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
		if (path.endsWith('.css')) return 'text/css; charset=utf-8';
		if (path.endsWith('.json')) return 'application/json; charset=utf-8';
		if (path.endsWith('.svg')) return 'image/svg+xml';
		if (path.endsWith('.webp')) return 'image/webp';
		if (path.endsWith('.png')) return 'image/png';
		if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
		if (path.endsWith('.gif')) return 'image/gif';
		if (path.endsWith('.woff2')) return 'font/woff2';
		/**
		 * The one entry the browser refuses to guess for.
		 *
		 * `WebAssembly.instantiateStreaming` checks the media type and rejects anything that is not
		 * `application/wasm` — it will not sniff the magic bytes. PGlite ships its engine as `.wasm`
		 * inside the workspace bundle, so falling through to `application/octet-stream` failed the
		 * replica with `Response has unsupported MIME type`, from a file that was served correctly in
		 * every other respect. A missing line here is indistinguishable from a corrupt download.
		 */
		if (path.endsWith('.wasm')) return 'application/wasm';
		if (path.endsWith('.sql')) return 'text/plain; charset=utf-8';
		return 'application/octet-stream';
	};

	/** Owns embedded assets behavior at the compiler boundary so validation and typed semantics stay consistent for every caller. */
	static readonly embeddedAssets = (root: string, workspaceKey: string) => {
		const read = (path: string, servedAt: string) =>
			Effect.gen(function* () {
				const bytes = yield* Effect.tryPromise(() => readFile(path));
				return {
					path: servedAt,
					contentType: WorkspaceCompiler.contentType(path),
					sha256: createHash('sha256').update(bytes).digest('hex'),
					base64: bytes.toString('base64')
				};
			});
		return Effect.gen(function* () {
			const dist = join(root, '.norbital', 'dist');
			const built = (yield* WorkspaceCompiler.filesUnder(dist)).toSorted();
			/**
			 * A workspace with no compiled client is a build failure, not a quiet artifact.
			 *
			 * This read used to happen before anything in the sync had run, so it embedded whatever the
			 * previous build had left behind — and a checkout whose `dist` was a day older than its
			 * `generated` shipped that older client inside a new release, silently. It now runs after
			 * the client build in the same sync, and an empty directory means that build emitted
			 * nothing, which nothing downstream can report better than here.
			 */
			if (built.length === 0) {
				return yield* Effect.fail(
					new Error(
						`No compiled client under ${dist}. \`bolt sync\` builds it; an empty directory means that build produced no output.`
					)
				);
			}
			/**
			 * The one file a host fetches by name has to be there, not merely *some* output.
			 *
			 * The emptiness check above cannot see the failure this catches. A workspace whose resolved
			 * `@norbital-ai/bolt/vite` predates the fixed entry name builds happily and fills this
			 * directory with an `index.html` and a content-hashed entry — non-empty, so nothing
			 * complained — and the host then asked for `/__bolt/static/workspace.js`, got a 404, and
			 * rendered a workspace with no apps. That is a stale plugin, and a stale plugin is invisible
			 * at the only place it can be named cheaply: here, where the build has just run and the file
			 * list is already in hand.
			 *
			 * It is checked against `bolt sync`'s own constant rather than the resolved plugin's, on
			 * purpose. The name is the contract between the artifact and every host that serves it; if
			 * the plugin that just ran disagrees with the compiler that is about to embed its output,
			 * the disagreement is the defect.
			 */
			if (!built.some((path) => relative(dist, path) === WORKSPACE_ENTRY_FILE_NAME)) {
				return yield* Effect.fail(
					new Error(
						[
							`The client build under ${dist} emitted no ${WORKSPACE_ENTRY_FILE_NAME}.`,
							`It emitted: ${built.map((path) => WorkspaceCompiler.posix(relative(dist, path))).join(', ')}.`,
							`A host fetches this artifact's client at \`${BOLT_TENANT_STATIC_PREFIX}/${WORKSPACE_ENTRY_FILE_NAME}\`, so an artifact without it serves a workspace with no apps.`,
							`This is what a stale \`@norbital-ai/bolt\` looks like: check that the workspace resolves the same build as the \`bolt\` that ran this sync (\`node -e "console.log(require.resolve('@norbital-ai/bolt/package.json'))"\` in the workspace root), and re-link or re-install if it does not.`
						].join(' ')
					)
				);
			}
			// Authored media travels in the artifact under the URL the workspace already writes into its
			// `<meta bolt:banner>` tags. Serving it from a host route instead would make an app header
			// depend on which host loaded the bundle, and the artifact is supposed to run unchanged on both.
			const media = join(root, 'assets');
			const authored = (yield* WorkspaceCompiler.filesUnder(media)).toSorted();
			return yield* Effect.all(
				[
					...built.map((path) => read(path, `/${WorkspaceCompiler.posix(relative(dist, path))}`)),
					...authored.map((path) =>
						read(
							path,
							`${BOLT_TENANT_REQUEST_PREFIX}/api/template-seed-assets/${workspaceKey}/${WorkspaceCompiler.posix(relative(media, path))}`
						)
					)
				],
				{ concurrency: 'unbounded' }
			);
		});
	};

	/**
	 * Owns render artifact behavior at the compiler boundary so validation and typed semantics stay
	 * consistent for every caller.
	 *
	 * **One options object, not a positional run.** This took twenty-one positional parameters,
	 * twelve of which were consecutive `ReadonlyArray`s, and it silently mis-wired twice: once when
	 * `+agent.ts` reached a compiler that discovered it by no glob at all, and again when a
	 * rate-limit file inserted ahead of an agent file shifted every later argument by one and the
	 * agent file was read into the rate-limit slot. Both times the artifact still rendered, still
	 * typechecked and still ran — a synthesized placeholder agent was a valid artifact — so the only
	 * signal was a test asserting on content. There is no placeholder agent to synthesize any more,
	 * which removes the shape of failure as well as the two instances of it.
	 *
	 * Twice makes it the signature's defect rather than either call site's. Named fields mean a
	 * misplaced argument is a type error, a missing one is a type error, and adding a parameter
	 * stops being an ordering decision. It also makes the call sites readable: nothing
	 * distinguished the empty relations list from the empty apps list when both were spelled `[]`.
	 */
	static readonly renderArtifact = (input: RenderArtifactInput): string => {
		const {
			metadata,
			collections,
			relations,
			apps,
			policies,
			functions,
			toolFiles,
			envoyFiles,
			automations,
			automationFiles,
			pipelineFiles,
			skills,
			mcpFiles = [],
			prompt,
			root,
			assets,
			customTypeDefinitions,
			environmentFile,
			migrations,
			integrationFiles = [],
			anonymousLimitFile,
			teamsFile
		} = input;
		const functionNames = functions.map((path) => basename(path).slice(1, -3));
		const policyNames = policies.map((path) => basename(path).slice(1, -3));
		const tools = toolFiles.map((path) => basename(path).slice(1, -3));
		const envoys = envoyFiles.map((path) => basename(path).slice(1, -3));
		const mcpServers = mcpFiles.map((path) => basename(path).slice(1, -3));
		const fingerprint = createHash('sha256')
			.update(
				JSON.stringify({
					collections: collections.map((collection) => collection.name),
					apps: apps.map((app) => app.name),
					policies: policyNames,
					functions: functionNames,
					tools,
					envoys,
					automations,
					mcpServers,
					skills,
					prompt
				})
			)
			.digest('hex');
		const authoredTools = tools.map((name) => ({
			name,
			description: `Workspace tool ${name}`,
			command: `workspace:${name}`
		}));
		const requiredFacilities =
			mcpFiles.length === 0
				? (['database', 'ai', 'tasks', 'files', 'hostTools'] as const)
				: (['database', 'ai', 'tasks', 'files', 'hostTools', 'connector'] as const);
		const manifestFacilities =
			mcpFiles.length === 0
				? (['ai', 'database', 'tasks'] as const)
				: (['ai', 'connector', 'database', 'tasks'] as const);
		const workspace = {
			name: metadata.name,
			version: metadata.version,
			collections: collections.map((collection) => ({
				name: collection.name,
				fields: collection.fields,
				history: true
			})),
			relations,
			apps: apps.map((app) => ({
				name: app.name,
				label: app.label,
				...(app.icon === undefined ? {} : { icon: app.icon }),
				...(app.description === undefined ? {} : { description: app.description }),
				...(app.banner === undefined ? {} : { banner: app.banner }),
				...(app.thumbnail === undefined ? {} : { thumbnail: app.thumbnail })
			})),
			policies: [],
			// `src/+agents.md`, verbatim. It is the system message of every agent turn in this
			// workspace, web and envoy alike, and it replaces the one-line placeholder this literal
			// used to carry for an agent nobody declared.
			prompt,
			tools: authoredTools,
			skills,
			// The name and the trigger only. `policies` and the handler come from the module itself,
			// merged in below, because it is the module that knows — the cron here is a placeholder the
			// artifact overwrites, exactly as it always was.
			automations: automations.map((name) => ({
				name,
				trigger: { _tag: 'Schedule', cron: '0 * * * *' },
				command: name,
				policies: []
			})),
			// Only the one fact the authored module cannot state about itself: its file's name.
			// Everything else — the transport, the audience, the policies, the task — is merged in below
			// from the module. This descriptor used to carry `transport: 'agent'` and `audience: 'both'`
			// as literals for every channel in every workspace, which is how a Telegram sales desk
			// declared `audience: 'public'` and arrived at the runtime open to everyone.
			envoys: envoys.map((name) => ({ name })),
			// Integrations are *not* listed here. They are computed in the emitted artifact from the live
			// modules imported below and spliced into the definition beside `collections` and `channels`,
			// because half of what a binding is — its record schema, its identity reader, its mapper — is a
			// live object that this JSON literal physically cannot hold. `integrations: []` sat here as a
			// literal for the whole life of the compiler, which is why seven authored files reached nothing.
			integrations: [],
			requiredFacilities,
			// The lineage travels with the artifact. Without it a promoted bundle physically cannot carry
			// its own schema history: `bolt migrate` wrote entries into `.norbital/migrations`, `sync`
			// embedded `.norbital/dist` and `assets` and nothing else, and no code path on any host ever
			// opened one — so every ALTER the lineage held stayed on the authoring machine's disk.
			migrations
		};
		const manifest = {
			// The version the artifact speaks, and the same constant the host validates it against —
			// this literal used to be `1` and drifted from `PROTOCOL_VERSION`, which every host then
			// refused with "invalid artifact manifest: Expected 2 at [\"protocolVersion\"]".
			protocolVersion: PROTOCOL_VERSION,
			artifactId: `${metadata.name}:local`,
			artifactVersion: metadata.version,
			schemaFingerprint: `sha256:${fingerprint}`,
			requiredFacilities: manifestFacilities
		};
		const modelImports = collections
			.map(
				(collection, index) =>
					`import model${index} from ${JSON.stringify(WorkspaceCompiler.sourceImport(root, collection.path))};`
			)
			.join('\n');
		const modelEntries = collections
			.map((collection, index) => `${JSON.stringify(collection.name)}: model${index}`)
			.join(', ');
		const hookImports = collections
			.flatMap((collection, index) =>
				collection.hooksPath === undefined
					? []
					: [
							`import hooks${index} from ${JSON.stringify(WorkspaceCompiler.sourceImport(root, collection.hooksPath))};`
						]
			)
			.join('\n');
		const hookEntriesByCollection = collections
			.flatMap((collection, index) =>
				collection.hooksPath === undefined
					? []
					: [`${JSON.stringify(collection.name)}: hooks${index}`]
			)
			.join(', ');
		const sourcePaths = collections
			.map(
				(collection) =>
					`${JSON.stringify(collection.name)}: ${JSON.stringify(collection.sourcePath)}`
			)
			.join(', ');
		const policyImports = policies
			.map(
				(path, index) =>
					`import policy${index} from ${JSON.stringify(WorkspaceCompiler.sourceImport(root, path))};`
			)
			.join('\n');
		const functionImports = functions
			.map(
				(path, index) =>
					`import fn${index} from ${JSON.stringify(WorkspaceCompiler.sourceImport(root, path))};`
			)
			.join('\n');
		const authoredToolImports = toolFiles.map(
			(path, index) =>
				`import tool${index} from ${JSON.stringify(WorkspaceCompiler.sourceImport(root, path))};`
		);
		const mcpImports = mcpFiles.map(
			(path, index) =>
				`import mcp${index} from ${JSON.stringify(WorkspaceCompiler.sourceImport(root, path))};`
		);
		const mcpEntries = mcpServers
			.map((name, index) => `${JSON.stringify(name)}: mcp${index}`)
			.join(', ');
		const mcpRegistry =
			mcpFiles.length === 0
				? []
				: [
						"import { agentTools } from '@norbital-ai/bolt/authoring/internals';",
						`const declaredMcpServers = {${mcpEntries}};`
					];
		const schemaImport =
			functions.length === 0 && toolFiles.length === 0 ? [] : ["import { Schema } from 'effect';"];
		const toolImports = [
			...schemaImport,
			...authoredToolImports,
			...mcpImports,
			...mcpRegistry
		].join('\n');
		const automationImports = automationFiles
			.map(
				(path, index) =>
					`import automation${index} from ${JSON.stringify(WorkspaceCompiler.sourceImport(root, path))};`
			)
			.join('\n');
		const pipelineImports = pipelineFiles
			.map(
				(path, index) =>
					`import pipelines${index} from ${JSON.stringify(WorkspaceCompiler.sourceImport(root, path))};`
			)
			.join('\n');
		// A `+pipelines.ts` lives in its collection's directory, so the directory names it — the same
		// derivation `customTypeEntries` uses. Hooks can read `collection.hooksPath` because discovery
		// attaches it; pipelines arrive as a flat file list, so the path is the only thing that knows.
		const pipelineEntriesByCollection = pipelineFiles
			.map((path, index) => `${JSON.stringify(basename(dirname(path)))}: pipelines${index}`)
			.join(', ');
		// A definition deliberately has no name: the `+<name>.ts` file owns it. Project the authored
		// definition into the runtime shape here so change events stay change events, schedules retain
		// their real cron, and the emitted map cannot collapse onto an `undefined` key.
		const automationEntries = automations
			.map(
				(name, index) =>
					`{ name: ${JSON.stringify(name)}, trigger: 'schedule' in automation${index}.trigger ? { _tag: 'Schedule', cron: automation${index}.trigger.schedule } : { _tag: 'Change', collection: automation${index}.trigger.trigger.collection, event: automation${index}.trigger.trigger.event }, policies: automation${index}.spec.policies, handler: automation${index}.spec.handler }`
			)
			.join(', ');
		// Imported live, as models, policies and tools are, rather than being read out of the file's text.
		// An envoy module is a plain object literal today, but reading it as source is how the model
		// scraper lost every generated column, and the import costs nothing the artifact was not already
		// paying: the same file has to be bundled either way.
		const envoyImports = envoyFiles
			.map(
				(path, index) =>
					`import envoy${index} from ${JSON.stringify(WorkspaceCompiler.sourceImport(root, path))};`
			)
			.join('\n');
		const envoyEntries = envoyFiles
			.map((path, index) => `${JSON.stringify(envoys[index])}: envoy${index}`)
			.join(', ');
		// Custom-type definitions are imported live, exactly as models and hooks are. A schema is a live
		// object and cannot survive `JSON.stringify`, so a serialised declaration would have carried the
		// names and lost the only part that can actually validate a value.
		const customTypeImports = customTypeDefinitions
			.map(
				(path, index) =>
					`import customType${index} from ${JSON.stringify(WorkspaceCompiler.sourceImport(root, path))};`
			)
			.join('\n');
		// `+integrations.ts`, keyed by the collection directory that declares it — the same derivation
		// hooks and pipelines use. Imported live for the reason above and then some: a binding's `input` is
		// a `Schema.Codec` and its `identity.value` is a closure, so a source scrape would recover the URL
		// and lose both the validation and the key that makes a re-run an update instead of a duplicate.
		const integrationImports = integrationFiles
			.map(
				(path, index) =>
					`import integrations${index} from ${JSON.stringify(WorkspaceCompiler.sourceImport(root, path))};`
			)
			.join('\n');
		const integrationEntries = integrationFiles
			.map((path, index) => `${JSON.stringify(basename(dirname(path)))}: integrations${index}`)
			.join(', ');
		// Imported into the artifact — which only ever runs on a host — and never into the client entry.
		// This is the declaration, not the values; the values are rows the vault reads at request time.
		const rateLimitImport =
			anonymousLimitFile === undefined
				? ''
				: `import declaredAnonymousLimits from ${JSON.stringify(WorkspaceCompiler.sourceImport(root, anonymousLimitFile))};`;
		const rateLimitEntry =
			anonymousLimitFile === undefined ? '' : ', rateLimits: declaredAnonymousLimits';
		// The team → policies map. It rides the definition rather than a facility because it is
		// authority, and authority in this design is something a release states and a database row
		// never asserts: a `team` row supplies only a name to look up here.
		const teamsImport =
			teamsFile === undefined
				? ''
				: `import declaredTeams from ${JSON.stringify(WorkspaceCompiler.sourceImport(root, teamsFile))};`;
		const declaredTeamsEntry = teamsFile === undefined ? '' : ', teams: declaredTeams';
		const mcpToolsEntry =
			mcpFiles.length === 0
				? ''
				: ', tools: agentTools(declaredWorkspace.tools, declaredMcpServers)';
		const teamsEntry = `${declaredTeamsEntry}${mcpToolsEntry}`;
		const environmentImport =
			environmentFile === undefined
				? ''
				: `import declaredEnvironment from ${JSON.stringify(WorkspaceCompiler.sourceImport(root, environmentFile))};`;
		// Imported live for the reason every other authored module is: reading the object out of the
		// file's text is how the model scraper lost every generated column, and the file has to be
		// bundled either way.
		const environmentEntry =
			environmentFile === undefined ? '' : ', environment: declaredEnvironment';
		const customTypeEntries = customTypeDefinitions
			.map((path, index) => `${JSON.stringify(basename(dirname(path)))}: customType${index}`)
			.join(', ');
		// Keyed by the policy's file name, because the file name *is* the policy's name and the module
		// no longer states one. The map is what `describePolicy` reads to attach it.
		const policyEntries = policies
			.map((_, index) => `${JSON.stringify(policyNames[index])}: policy${index}`)
			.join(', ');
		const functionEntries = functions
			.map(
				(path, index) =>
					`${JSON.stringify(basename(path).slice(1, -3))}: (input, api) => fn${index}.handler(Schema.decodeUnknownSync(fn${index}.schema)(input), api)`
			)
			.join(',\n\t');
		// The author's Effect Schema is the boundary. The handler receives only its decoded output, and
		// the runtime's single authored-handler interpreter executes an Effect it returns.
		const toolEntries = toolFiles
			.map(
				(path, index) =>
					`${JSON.stringify(basename(path).slice(1, -3))}: (input, api) => tool${index}.run(api, Schema.decodeUnknownSync(tool${index}.input)(input))`
			)
			.join(',\n\t');
		return `import { makeBundle } from '@norbital-ai/bolt/runtime';\nimport { describeEnvoy, describeHooks, describeIntegrations, compileModel, describePolicy, manifestIntegrations } from '@norbital-ai/bolt/authoring/internals';\n${modelImports}\n${hookImports}\n${policyImports}\n${functionImports}\n${toolImports}\n${automationImports}\n${pipelineImports}\n${envoyImports}\n${customTypeImports}\n${integrationImports}\n${environmentImport}\n${rateLimitImport}\n${teamsImport}\n// Keyed by file name, because a policy's name *is* its file and the module states none. Only what\n// the workspace declares reaches this map: two synthetic policies used to be appended and both were\n// mistakes of the same kind — authority modelled as a group. \`admin\` granted every action on every\n// app to a founder, which administration status already does; \`local-authoring\` granted the same to\n// every authenticated subject in any workspace that had authored no policies at all.\nconst authoredPolicies = {${policyEntries}};\n// A policy's name is its filename, attached here and stated nowhere else. \`describePolicy\` also\n// normalises the four capability lists, resolves every rate rule's key, and derives an approval's\n// identity from (policy, collection, action, step key) — so there is no authored id anywhere for a\n// copy-paste to duplicate and no \`name:\` field to disagree with the file it is in.\nconst policies = Object.entries(authoredPolicies).map(([name, declaration]) => describePolicy(name, declaration));\nconst declaredModels = {${modelEntries}};\nconst declaredHooks = {${hookEntriesByCollection}};\nconst collectionSourcePaths = {${sourcePaths}};\nconst declaredCustomTypes = {${customTypeEntries}};\nconst declaredEnvoys = {${envoyEntries}};\nconst declaredPipelines = {${pipelineEntriesByCollection}};\nconst declaredIntegrationModules = {${integrationEntries}};\n// Split here, at artifact boot, because the two halves go to two different places: the declarations\n// join the workspace definition a host can read, and the live schemas and closures ride in the\n// authored runtime beside hooks and pipelines.\nconst describedIntegrations = describeIntegrations(declaredIntegrationModules);\nconst declaredAutomations = Object.fromEntries([${automationEntries}].map((automation) => [automation.name, automation]));\nconst declaredWorkspace = ${JSON.stringify(workspace, null, 2)};\n// The declaration is the authority: it carries generated expressions and enum members that\n// reading the source text cannot recover.\nconst collections = declaredWorkspace.collections.map((collection) =>\n\tcompileModel(collection, declaredModels[collection.name], {\n\t\thooks: describeHooks(declaredHooks[collection.name]),\n\t\tsourcePath: collectionSourcePaths[collection.name]\n\t})\n);\n// The authored module is the authority on every field but its name, which comes from the file.\nconst envoys = declaredWorkspace.envoys.map(({ name }) => describeEnvoy(name, declaredEnvoys[name]));\n// An automation's declaration is the trigger and the name the descriptor carries, plus the policies\n// the module declares — its authority, which used to be whatever its trigger happened to hold.\nconst automations = declaredWorkspace.automations.map((automation) => ({ ...automation, ...(declaredAutomations[automation.name] === undefined ? {} : { trigger: declaredAutomations[automation.name].trigger, policies: declaredAutomations[automation.name].policies }) }));\nconst workspace = { ...declaredWorkspace, collections, envoys, automations, policies, customTypes: declaredCustomTypes, integrations: describedIntegrations.declarations${environmentEntry}${rateLimitEntry}${teamsEntry} };\nconst encodedAssets = ${JSON.stringify(assets)};\nconst staticAssets = encodedAssets.map(({ base64, ...asset }) => ({ ...asset, bytes: Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)) }));\n// Integrations are projected here rather than baked into the literal above, for the same reason\n// they are spliced into the workspace here: they only exist once the live modules have been\n// imported and split. The manifest literal is written at compile time and cannot hold them, which\n// is why \`buildManifest\` publishing them reached every test and no artifact.\nconst manifestValue = { ...${JSON.stringify(manifest, null, 2)}, staticAssets, integrations: manifestIntegrations(describedIntegrations.declarations) };\nconst remoteHandlers = {\n\t${functionEntries}\n};\nconst toolHandlers = {\n\t${toolEntries}\n};\nconst authoredRuntime = { hooks: declaredHooks, pipelines: declaredPipelines, automations: declaredAutomations, integrations: describedIntegrations.authored };
const bundle = makeBundle(workspace, manifestValue, remoteHandlers, toolHandlers, authoredRuntime);\nexport const protocolVersion = bundle.protocolVersion;\nexport const manifest = bundle.manifest;\nexport const dispatch = bundle.dispatch;\nexport const activate = bundle.activate;\nexport default bundle;\n`;
	};

	/** Owns write behavior at the compiler boundary so validation and typed semantics stay consistent for every caller. */
	static readonly write = (path: string, content: string) =>
		Effect.gen(function* () {
			yield* Effect.tryPromise(() => mkdir(dirname(path), { recursive: true }));
			yield* Effect.tryPromise(() => writeFile(path, content, 'utf8'));
		});
}

/**
 * Statement separator in a `migration.sql`.
 *
 * drizzle-kit writes it, the lineage on disk already uses it, and Bolt's applier splits on it — so it
 * is the file format, not a convention this compiler invents.
 */
export const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

/**
 * One `migration.sql` as the statements an applier runs, in file order.
 *
 * Order is preserved exactly and nothing is reordered, deduplicated or normalised: entries are
 * hand-editable and committed, and `20260816190844_auto` is the proof that the ordering carries
 * meaning — its hand-authored `UPDATE`s sit above the generated `DROP COLUMN`s precisely so data is
 * cleaned while the columns it may need still exist.
 */
const migrationStatements = (source: string): ReadonlyArray<string> =>
	source
		.split(STATEMENT_BREAKPOINT)
		.map((part) => part.trim())
		.filter((part) => part !== '');

/**
 * The workspace's migration lineage, oldest first.
 *
 * Sorted by tag, which is the `<UTC timestamp>_<name>` directory name, so lexical order is
 * chronological order — the order the entries were generated in and the only order in which they
 * mean anything.
 *
 * An entry whose `migration.sql` cannot be read is fatal rather than skipped. A lineage with a hole
 * in it applies the entries around the hole and leaves the database in a shape no snapshot
 * describes, which is worse than not migrating at all.
 */
export const readWorkspaceMigrations = (workspaceRoot: string) =>
	Effect.gen(function* () {
		const migrationsRoot = join(workspaceRoot, '.norbital', 'migrations');
		const entries = yield* Effect.tryPromise(() =>
			readdir(migrationsRoot, { withFileTypes: true })
		).pipe(Effect.catch(() => Effect.succeed<Array<Dirent>>([])));
		const tags = entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.toSorted();
		return yield* Effect.all(
			tags.map((tag) =>
				Effect.gen(function* () {
					const source = yield* Effect.tryPromise(() =>
						readFile(join(migrationsRoot, tag, 'migration.sql'), 'utf8')
					);
					return { tag, statements: migrationStatements(source) };
				})
			),
			{ concurrency: 'unbounded' }
		);
	});

/** Discovers filesystem-first Bolt authoring roles without writing generated output. */
export const discoverAuthoredSource = (workspaceRoot = process.cwd()) => {
	const compiler = WorkspaceCompiler;
	const root = resolve(workspaceRoot);
	const sourceRoot = join(root, 'src');
	return Effect.gen(function* () {
		const files = yield* compiler.filesUnder(sourceRoot);
		const models = files.filter((path) => basename(path) === '+model.ts').sort();
		if (models.length === 0) {
			return yield* Effect.fail(
				new Error('Bolt sync found no src/collections/*/+model.ts declarations')
			);
		}
		/**
		 * Every authored kind, discovered by the directory it lives in and by nothing else.
		 *
		 * The rule is one shape: `src/<what kind>/+<which one>.<ext>`. The kind is the directory, the
		 * name is the file, and a `+` prefix means the compiler reads this file while no prefix means
		 * it is the author's own. Nothing is discovered by suffix from anywhere any more — a policy
		 * used to be `/\+[^/]+\.policy\.ts$/` matched at any depth, which meant the file could sit
		 * anywhere and the suffix carried the kind, so a name was spelled twice and a kind twice.
		 */
		const inDirectory = (path: string, directory: string): boolean =>
			compiler.posix(dirname(path)) === compiler.posix(join(sourceRoot, directory));
		const declaredIn = (directory: string, extension = '.ts'): ReadonlyArray<string> =>
			files
				.filter(
					(path) =>
						inDirectory(path, directory) &&
						basename(path).startsWith('+') &&
						path.endsWith(extension)
				)
				.sort();
		const namesOf = (paths: ReadonlyArray<string>, extension = '.ts'): ReadonlyArray<string> =>
			paths.map((path) => basename(path).slice(1, -extension.length));

		/**
		 * The workspace's own field types, one file each.
		 *
		 * `datatypes/`, a sibling of `collections/` rather than a child of it, because
		 * `collections/quotes/` and `collections/custom_datatypes/` would sit at the same level while
		 * being different *kinds* of thing — one an instance, one a category. It is also literally
		 * true: a datatype is not a collection. The word *custom* is dropped along the way; everything
		 * under `src/` is the author's, so there is no non-custom counterpart to distinguish from.
		 *
		 * A directory, like a collection, because a datatype has two authored artifacts: the schema and
		 * the renderer that reads a value of it. The alternative — `+money.ts` beside `+money.svelte` —
		 * would make the *extension* carry which artifact it is, which is a third naming convention
		 * where the directory rule already answers the question.
		 */
		const definitions = files
			.filter(
				(path) =>
					basename(path) === '+definition.ts' &&
					compiler.posix(dirname(dirname(path))) === compiler.posix(join(sourceRoot, 'datatypes'))
			)
			.sort();
		const datatypeNames = definitions.map((path) => basename(dirname(path)));
		const appFiles = files
			.filter(
				(path) =>
					basename(path).startsWith('+') &&
					path.endsWith('.svelte') &&
					compiler.posix(path).includes('/apps/')
			)
			.sort();
		const appNames = appFiles.map((path) =>
			compiler
				.posix(relative(join(sourceRoot, 'apps'), path))
				.replace(/(^|\/)\+/, '$1')
				.replace(/\.svelte$/, '')
		);
		const collectionNames = models.map((path) => basename(dirname(path)));
		const policyFiles = declaredIn('access/policies');
		const policies = namesOf(policyFiles);
		const functionFiles = declaredIn('functions');
		const functions = namesOf(functionFiles);
		/**
		 * A collection's authored record surface.
		 *
		 * `+representation.svelte` is how a workspace says what a record *is* — which fields belong on
		 * the sheet, in what order, under which labels, through which renderer. Without it the sheet
		 * falls back to the auto-emitted form, which paints every writable column and shows a `custom()`
		 * value as raw JSON. The template ships one per collection and none of them were compiled.
		 */
		const representationFiles = files
			.filter(
				(path) =>
					basename(path) === '+representation.svelte' &&
					compiler.posix(path).includes('/collections/')
			)
			.sort();
		/**
		 * A custom type's own renderer, keyed by the type name a column declares.
		 *
		 * `custom('leave_event')` is a jsonb column whose shape only its author knows, so the type ships
		 * the component that reads it. Without these a `custom()` field falls through to the JSON dump,
		 * which is what "What happened" was showing.
		 */
		/**
		 * A datatype's own renderer, beside its definition in the same directory.
		 *
		 * `custom('leave_event')` is a jsonb column whose shape only its author knows, so the type
		 * ships the component that reads it. Without one a `custom()` field falls through to a raw JSON
		 * dump, which is what "What happened" was showing before these were compiled at all.
		 */
		const customRendererFiles = files
			.filter(
				(path) =>
					basename(path) === '+renderer.svelte' &&
					compiler.posix(dirname(dirname(path))) === compiler.posix(join(sourceRoot, 'datatypes'))
			)
			.sort();
		/**
		 * `src/+env.ts` — the workspace's declared relationship with its outside environment.
		 *
		 * It is a compiler-owned source declaration like `+agents.md` and `+seed.ts`, so it belongs under
		 * `src/`. Looking at the repository root made the compiler miss the tracked declaration in every
		 * template and then reject it as an unknown authored path.
		 */
		const environmentFile = files.find(
			(path) => basename(path) === '+env.ts' && dirname(path) === sourceRoot
		);
		/**
		 * `src/+agents.md` — the system message of every agent turn in this workspace.
		 *
		 * **Required.** There is no synthesized fallback, because the fallback was the defect: the
		 * compiler wrote `"You are the <name> workspace agent."` and five of six workspaces shipped
		 * it, including both of the two whose agents were reachable from outside.
		 *
		 * It is `+agents.md` and not `AGENTS.md`, and the difference is load-bearing. `AGENTS.md` is
		 * the standard filename for instructions to *coding* agents, and `templates/AGENTS.md` already
		 * exists for that — so a coding agent working in a workspace would read a product prompt as
		 * instructions, and, worse in reverse, anything written for a coding agent that landed there
		 * ("run pnpm test before committing") would become part of a customer-facing agent's system
		 * prompt. The `+` marks it as a file the compiler reads, and coding agents look for `AGENTS.md`,
		 * which this is not. Neither can be mistaken for the other.
		 */
		const promptFile = files.find(
			(path) => basename(path) === '+agents.md' && dirname(path) === sourceRoot
		);
		/**
		 * `src/access/+anonymous_limits.ts` — what a caller may do before they have signed in.
		 *
		 * The only rate-limit file left, and separate for a structural reason rather than a stylistic
		 * one: before sign-in there is no subject, so there is no policy to hang a limit on. Everything
		 * with a holder is declared by that holder.
		 */
		const anonymousLimitFile = files.find(
			(path) => basename(path) === '+anonymous_limits.ts' && inDirectory(path, 'access')
		);
		/**
		 * `src/access/+teams.ts` — which policies each named team holds.
		 *
		 * Beside the policies it hands out and the limits that apply before anybody holds one, because
		 * all three are statements about authority. Optional — a workspace that declares no teams
		 * grants nothing through membership, which is the right answer for one that has not said
		 * otherwise — but a workspace with no teams also has no valid approver, because `TeamName` is
		 * generated from this file's own keys.
		 */
		const teamsFile = files.find(
			(path) => basename(path) === '+teams.ts' && inDirectory(path, 'access')
		);
		const hookFiles = files.filter((path) => basename(path) === '+hooks.ts').sort();
		const pipelineFiles = files.filter((path) => basename(path) === '+pipelines.ts').sort();
		/**
		 * A collection's inbound bindings.
		 *
		 * Discovered by the same rule as `+hooks.ts` and `+pipelines.ts` — the directory names the
		 * collection — which is all it ever needed. Until this line existed no glob matched the
		 * filename, so seven authored files across four templates compiled, typechecked, and reached
		 * nothing; `auditDiscardedIntegrations` warned about exactly that and is deleted with it.
		 */
		const integrationFiles = files
			.filter(
				(path) =>
					basename(path) === '+integrations.ts' && compiler.posix(path).includes('/collections/')
			)
			.sort();
		/**
		 * What a policy may grant beyond data, filed under `capabilities/` and not under `agent/`.
		 *
		 * They are granted by **policies**, not owned by agents — a sales rep and a controller reach
		 * different tools through the same web agent — so filing them beside an agent would teach a
		 * new author the opposite of the model on their first day. `capabilities/` is named for the
		 * field that grants them.
		 */
		const toolFiles = declaredIn('capabilities/tools');
		const toolNames = namesOf(toolFiles);
		const mcpFiles = declaredIn('capabilities/mcp');
		const mcpServerNames = namesOf(mcpFiles);
		const envoyFiles = declaredIn('envoys');
		const envoyNames = namesOf(envoyFiles);
		const automationFiles = declaredIn('automations');
		const automationNames = namesOf(automationFiles);
		/**
		 * A skill: the one thing besides a collection that earns a directory, because its content is
		 * the artifact and a directory is what lets it carry more than one file.
		 */
		const skillFiles = files
			.filter(
				(path) =>
					basename(path) === '+skill.md' &&
					compiler.posix(dirname(dirname(path))) ===
						compiler.posix(join(sourceRoot, 'capabilities', 'skills'))
			)
			.sort();
		const skillNames = skillFiles.map((path) => basename(dirname(path))).sort();
		const groupFiles = files
			.filter((path) => basename(path) === '+group.ts' && compiler.posix(path).includes('/apps/'))
			.sort();
		const groupNames = groupFiles.map((path) =>
			compiler.posix(relative(join(sourceRoot, 'apps'), dirname(path)))
		);
		/**
		 * A `+`-prefixed file the compiler has no rule for, which is an authoring mistake and not a
		 * silent no-op.
		 *
		 * The `+` prefix means "the compiler reads this", so a file that carries one and is reached by
		 * nothing is a promise the tree does not keep. That is the exact failure this whole layout
		 * replaces: `+agent.ts` sat in five workspaces matching no glob, `+integrations.ts` sat in
		 * four, and both compiled and typechecked and reached nothing. Refusing here means a
		 * misfiled `+qualify_lead.ts` is a build error naming where it belongs, rather than a tool
		 * nobody can call.
		 */
		const discovered = new Set<string>([
			...models,
			...definitions,
			...customRendererFiles,
			...appFiles,
			...policyFiles,
			...functionFiles,
			...hookFiles,
			...pipelineFiles,
			...integrationFiles,
			...representationFiles,
			...toolFiles,
			...mcpFiles,
			...envoyFiles,
			...automationFiles,
			...skillFiles,
			...groupFiles,
			...(environmentFile === undefined ? [] : [environmentFile]),
			...(promptFile === undefined ? [] : [promptFile]),
			...(anonymousLimitFile === undefined ? [] : [anonymousLimitFile]),
			...(teamsFile === undefined ? [] : [teamsFile])
		]);
		const RELATIONSHIP_FILE = compiler.posix(join(sourceRoot, 'collections', '+relationship.ts'));
		const stray: Array<string> = [];
		for (const path of files) {
			if (!basename(path).startsWith('+')) continue;
			if (discovered.has(path)) continue;
			if (compiler.posix(path) === RELATIONSHIP_FILE) continue;
			stray.push(compiler.posix(relative(root, path)));
		}
		const emittedStray = stray.toSorted();
		if (emittedStray.length > 0) {
			return yield* Effect.fail(
				new Error(
					[
						`Bolt sync found ${emittedStray.length} authored file${emittedStray.length === 1 ? '' : 's'} the compiler has no rule for:`,
						...emittedStray.map((path) => `  - ${path}`),
						'',
						'A "+" prefix means the compiler reads this file, so one it cannot place is a promise the tree does not keep. Every authored path is src/<kind>/+<name>.<ext>:',
						'  a table                       collections/<name>/+model.ts',
						'  a field type                  datatypes/+<name>.ts',
						'  a permission                  access/policies/+<name>.ts',
						'  a team                        access/+teams.ts',
						'  pre-sign-in limits            access/+anonymous_limits.ts',
						'  a tool, server or skill       capabilities/tools|mcp|skills/',
						'  an agent on a transport       envoys/+<name>.ts',
						'  something on a schedule       automations/+<name>.ts',
						'  something a page calls        functions/+<name>.ts',
						'  a page                        apps/+<name>.svelte',
						'  declared environment          +env.ts',
						'  the shared system prompt      +agents.md',
						'',
						'A helper the compiler must ignore is any file without a "+".'
					].join('\n')
				)
			);
		}
		if (promptFile === undefined) {
			return yield* Effect.fail(
				new Error(
					'Bolt sync found no src/+agents.md. It is the system message of every agent turn in this workspace — what the collections mean, what the business does, house rules for tone and escalation. There is no default: the default was "You are the <name> workspace agent.", and five of six workspaces shipped it.'
				)
			);
		}
		const prompt = yield* Effect.tryPromise(() => readFile(promptFile, 'utf8'));
		if (prompt.trim() === '') {
			return yield* Effect.fail(
				new Error('src/+agents.md is empty. Describe the business this agent is standing in.')
			);
		}
		return {
			root,
			models,
			definitions,
			datatypeNames,
			appFiles,
			appNames,
			collectionNames,
			policyFiles,
			policies,
			functionFiles,
			functions,
			hookFiles,
			integrationFiles,
			representationFiles,
			customRendererFiles,
			environmentFile,
			anonymousLimitFile,
			teamsFile,
			promptFile,
			prompt,
			toolFiles,
			toolNames,
			mcpFiles,
			envoyFiles,
			envoyNames,
			automationNames,
			automationFiles,
			pipelineFiles,
			mcpServerNames,
			skillFiles,
			skillNames,
			groupFiles,
			groupNames
		};
	});
};

/** Owns the complete discover-generate-bundle synchronization transaction. */
const WorkspaceSynchronization = {
	sync: (workspaceRoot = process.cwd()) => {
		const compiler = WorkspaceCompiler;
		return Effect.gen(function* () {
			const {
				root,
				models,
				definitions,
				appFiles,
				appNames,
				collectionNames,
				policyFiles,
				policies,
				functionFiles,
				functions,
				hookFiles,
				integrationFiles,
				representationFiles,
				customRendererFiles,
				datatypeNames,
				environmentFile,
				anonymousLimitFile,
				teamsFile,
				prompt,
				toolFiles,
				toolNames,
				mcpFiles,
				envoyFiles,
				envoyNames,
				automationNames,
				automationFiles,
				pipelineFiles,
				mcpServerNames,
				skillFiles,
				skillNames,
				groupFiles
			} = yield* discoverAuthoredSource(workspaceRoot);
			const skills = yield* Effect.all(
				skillFiles.map((path) =>
					Effect.tryPromise(() => readFile(path, 'utf8')).pipe(
						Effect.map((body) => describeSkill(basename(dirname(path)), body))
					)
				),
				{ concurrency: 'unbounded' }
			);
			const metadata = yield* compiler.readPackageMetadata(root);
			const i18nMessages = yield* compiler.readI18nMessages(root);
			const generated = join(root, '.norbital', 'generated');
			const types = join(root, '.norbital', 'types');
			const relationshipSource = yield* Effect.tryPromise(() =>
				readFile(join(root, 'src', 'collections', '+relationship.ts'), 'utf8')
			).pipe(Effect.catch(() => Effect.succeed<string | undefined>(undefined)));
			const relations =
				relationshipSource === undefined ? [] : extractRelationships(relationshipSource);
			const collectionCatalog = yield* Effect.all(
				models.map((path) =>
					Effect.gen(function* () {
						const source = yield* Effect.tryPromise(() => readFile(path, 'utf8'));
						return extractCollectionCatalog(basename(dirname(path)), source, relations);
					})
				),
				{ concurrency: 'unbounded' }
			);
			const appMetaEntries = yield* Effect.all(
				appFiles.map((path) =>
					Effect.gen(function* () {
						const source = yield* Effect.tryPromise(() => readFile(path, 'utf8'));
						const meta = extractAppMetadata(source);
						const name = compiler
							.posix(relative(join(root, 'src', 'apps'), path))
							.replace(/(^|\/)\+/, '$1')
							.replace(/\.svelte$/, '');
						return [
							name,
							{
								...(meta.title === null ? {} : { label: meta.title }),
								...(meta.icon === null ? {} : { icon: meta.icon }),
								...(meta.description === null ? {} : { description: meta.description }),
								...(meta.banner === null ? {} : { banner: meta.banner }),
								...(meta.thumbnail === null ? {} : { thumbnail: meta.thumbnail })
							}
						] as const;
					})
				),
				{ concurrency: 'unbounded' }
			);
			const appMeta = Object.fromEntries(appMetaEntries);
			yield* Effect.all(
				[
					Effect.promise(() => rm(generated, { recursive: true, force: true })),
					Effect.promise(() => rm(types, { recursive: true, force: true }))
				],
				{ concurrency: 'unbounded' }
			);
			const groupEntries = yield* Effect.all(
				groupFiles.map((path) =>
					Effect.gen(function* () {
						const source = yield* Effect.tryPromise(() => readFile(path, 'utf8'));
						const meta = extractGroupMetadata(source);
						const name = compiler.posix(relative(join(root, 'src', 'apps'), dirname(path)));
						return {
							name,
							...(meta.label === null ? {} : { label: meta.label }),
							...(meta.description === null ? {} : { description: meta.description }),
							...(meta.icon === null ? {} : { icon: meta.icon }),
							...(meta.defaultChild === null ? {} : { defaultChild: meta.defaultChild })
						};
					})
				),
				{ concurrency: 'unbounded' }
			);
			yield* Effect.all(
				[
					compiler.write(join(generated, 'models.ts'), compiler.renderModels(models, root)),
					compiler.write(
						join(generated, 'custom-types.ts'),
						compiler.renderCustomTypes(definitions, root)
					),
					compiler.write(
						join(generated, 'authoring-types.ts'),
						compiler.renderAuthoringTypes({
							collections: collectionNames,
							apps: appNames,
							policies,
							functions,
							tools: toolNames,
							envoys: envoyNames,
							mcpServers: mcpServerNames,
							skills: skillNames,
							datatypes: datatypeNames,
							automations: automationNames,
							// Relative to `.norbital/generated/`, which is where this module is written.
							teamsImport:
								teamsFile === undefined
									? undefined
									: `../../${compiler.posix(relative(root, teamsFile)).replace(/\.ts$/, '.js')}`
						})
					),
					compiler.write(join(generated, 'i18n-keys.ts'), compiler.renderI18nKeys(i18nMessages.en)),
					compiler.write(
						join(generated, 'i18n-messages.js'),
						compiler.renderI18nMessages(i18nMessages)
					),
					compiler.write(
						join(generated, 'i18n-messages.d.ts'),
						compiler.renderI18nMessagesDeclaration()
					),
					compiler.write(
						join(generated, 'collections.js'),
						compiler.renderCollectionCatalog(collectionCatalog)
					),
					compiler.write(
						join(generated, 'collections.d.ts'),
						compiler.renderCollectionCatalogDeclaration()
					),
					compiler.write(join(generated, 'app.css'), compiler.renderWorkspaceStylesheet()),
					compiler.write(join(generated, 'types.ts'), compiler.renderTypes(relations)),
					compiler.write(
						join(generated, 'client.d.ts'),
						compiler.renderClientDeclaration(hookFiles, functionFiles, root)
					),
					compiler.write(
						join(generated, 'client.js'),
						compiler.renderClientRuntime(
							appFiles,
							groupEntries,
							appMeta,
							policies,
							root,
							representationFiles,
							customRendererFiles
						)
					),
					compiler.write(
						join(types, 'custom-type-values.d.ts'),
						compiler.renderCustomAugmentation(definitions, root)
					),
					compiler.write(
						join(types, 'workspace-authoring.d.ts'),
						compiler.renderWorkspaceAuthoring()
					),
					compiler.write(
						join(types, 'client-runtime.d.ts'),
						compiler.renderClientRuntimeDeclaration()
					),
					compiler.write(
						join(types, 'collections', '$types.d.ts'),
						compiler.renderRelationshipTypes()
					),
					compiler.write(
						join(types, 'access', 'policies', '$types.d.ts'),
						compiler.renderPolicyTypes()
					),
					compiler.write(join(types, 'access', '$types.d.ts'), compiler.renderAccessTypes()),
					compiler.write(join(types, 'envoys', '$types.d.ts'), compiler.renderEnvoyTypes()),
					compiler.write(join(types, 'functions', '$types.d.ts'), compiler.renderHandlerTypes()),
					compiler.write(join(types, 'automations', '$types.d.ts'), compiler.renderHandlerTypes()),
					compiler.write(join(root, '.norbital', 'tsconfig.json'), compiler.renderTsconfig()),
					...collectionNames.map((name) =>
						compiler.write(
							join(types, 'collections', name, '$types.d.ts'),
							compiler.renderCollectionTypes(name)
						)
					),
					...definitions.map((path) =>
						compiler.write(
							join(types, 'datatypes', basename(dirname(path)), '$types.d.ts'),
							compiler.renderCustomTypeRenderer(path, root)
						)
					)
				],
				{ concurrency: 'unbounded' }
			);
			/**
			 * The browser client, built by the command that builds the artifact it rides in.
			 *
			 * Nothing used to run this. `bolt sync` compiled the server artifact, `bolt build` was an
			 * alias for `bolt sync`, and every provisioning path — the reset script, the checkout
			 * compiler, the materialising compiler — ran `bolt sync` and nothing else. So a deployed
			 * artifact carried no client at all, and a local one carried whatever a developer had last
			 * built by hand. Adding the step to the provisioning scripts would have left the checkout
			 * compiler out, which is the path local development actually takes; putting it here means
			 * there is one command, and an artifact cannot exist without the client it serves.
			 *
			 * It runs after the generated modules are written, because it imports them, and before the
			 * assets are read, because those are its output. `configFile` is left alone so the
			 * workspace's own `vite.config.ts` is loaded — that file is where a workspace states extra
			 * build inputs, and one template ships a WebAssembly runtime through it.
			 *
			 * The cost is real and worth naming: every `bolt sync` is now a full Vite production build
			 * of the workspace's client, and every provisioning pays it.
			 */
			/**
			 * The workspace's own Vite config is required, and its absence is said out loud.
			 *
			 * `build` is called without `configFile`, so Vite loads `<root>/vite.config.ts` — which is
			 * where a workspace states its build, including the extra inputs one template needs to ship a
			 * WebAssembly runtime. A tree without one does not fail: Vite builds with no Bolt plugin at
			 * all, so there is no `$bolt` alias, no entry and no `outDir`, and the first thing anyone
			 * hears about it is an artifact whose client is missing. That is precisely the failure this
			 * whole change exists to stop being silent, so it is checked where it can still be named.
			 */
			if (!(yield* fileExists(join(root, 'vite.config.ts')))) {
				return yield* Effect.fail(
					new Error(
						`No vite.config.ts in ${root}. \`bolt sync\` builds the workspace client through it, so a materialized tree must carry it alongside package.json.`
					)
				);
			}
			yield* Effect.tryPromise({
				// A host serves the artifact below its own tenant namespace, not at the origin root.
				// Relative output keeps Vite's dynamic-import preloads, emitted CSS and font URLs beside
				// `workspace.js`; the default `/` base asks the host for `/assets/*` and bypasses
				// `/__bolt/static`, so static imports load while the first lazy client chunk 404s.
				try: () => build({ root, base: './', mode: 'production', logLevel: 'warn' }),
				catch: (cause) =>
					cause instanceof Error
						? cause
						: new Error(`Workspace client build failed: ${String(cause)}`)
			});
			// The authored URL keys assets by template name, not by npm scope: `@template/hr-payroll`
			// is served under `hr-payroll`.
			const assets = yield* compiler.embeddedAssets(
				root,
				metadata.name.split('/').at(-1) ?? metadata.name
			);
			const artifactDirectory = join(root, '.norbital', 'artifact');
			const artifactEntry = join(artifactDirectory, 'bundle-entry.mjs');
			const artifactPath = join(artifactDirectory, 'bundle.mjs');
			const appDescriptors = yield* Effect.all(
				appFiles.map((path, index) =>
					Effect.gen(function* () {
						const source = yield* Effect.tryPromise(() => readFile(path, 'utf8'));
						const meta = extractAppMetadata(source);
						const name =
							appNames[index] ?? compiler.posix(relative(join(root, 'src', 'apps'), path));
						return {
							name,
							label: meta.title ?? name,
							...(meta.icon === null ? {} : { icon: meta.icon }),
							...(meta.description === null ? {} : { description: meta.description }),
							// The app header renders a banner and the overview cards render a thumbnail. Both were
							// extracted and then dropped here, so every app header was image-less.
							...(meta.banner === null ? {} : { banner: meta.banner }),
							...(meta.thumbnail === null ? {} : { thumbnail: meta.thumbnail })
						};
					})
				),
				{ concurrency: 'unbounded' }
			);
			const hooksByCollection = new Map(hookFiles.map((path) => [basename(dirname(path)), path]));
			const collectionDescriptors = yield* Effect.all(
				models.map((path) =>
					Effect.gen(function* () {
						const name = basename(dirname(path));
						const hooksPath = hooksByCollection.get(name);
						return {
							name,
							path,
							sourcePath: compiler.posix(relative(root, path)),
							...(hooksPath === undefined ? {} : { hooksPath }),
							// Source extraction is the fallback only. The artifact reads the real declaration.
							fields: extractModelFields(yield* Effect.tryPromise(() => readFile(path, 'utf8')))
						};
					})
				),
				{ concurrency: 'unbounded' }
			);
			yield* compiler.write(
				artifactEntry,
				compiler.renderArtifact({
					metadata,
					collections: collectionDescriptors,
					relations,
					apps: appDescriptors,
					policies: policyFiles,
					functions: functionFiles,
					toolFiles,
					envoyFiles,
					automations: automationNames,
					automationFiles,
					pipelineFiles,
					skills,
					mcpFiles,
					prompt,
					root,
					assets,
					customTypeDefinitions: definitions,
					environmentFile,
					migrations: yield* readWorkspaceMigrations(root),
					integrationFiles,
					anonymousLimitFile,
					teamsFile
				})
			);
			const [
				authoringInternalsEntry,
				authoringEntry,
				runtimeEntry,
				clientRuntimeEntry,
				clientEntry,
				hostEntry,
				rootEntry
			] = yield* Effect.all(
				[
					boltEntry('src/authoring/internals.ts', 'build/authoring/internals.js'),
					boltEntry('src/authoring/index.ts', 'build/authoring/index.js'),
					boltEntry('src/runtime/app.ts', 'build/runtime/app.js'),
					boltEntry('src/client/runtime.ts', 'build/client/runtime.js'),
					boltEntry('src/client.ts', 'build/client.js'),
					boltEntry('src/host.ts', 'build/host.js'),
					boltEntry('src/index.ts', 'build/index.js')
				] as const,
				{ concurrency: 'unbounded' }
			);
			yield* Effect.promise(() =>
				build({
					root,
					configFile: false,
					/**
					 * Node's `global`, for dependencies that still reach for it.
					 *
					 * An artifact runs in a worker isolate, which has `globalThis` and no reason to define
					 * Node's older alias. A published package that reads it — `exifr`, in the template that
					 * indexes a JPEG corpus — therefore throws `global is not defined` the moment the host
					 * inspects the bundle, and the whole workspace is rejected for a line in a dependency
					 * nobody here wrote. Substituted at build time rather than shimmed at run time, because
					 * only one of those leaves the runtime able to say what globals an artifact actually has.
					 * esbuild replaces the bare identifier and leaves `x.global` and any shadowing binding
					 * alone, so this cannot reach anything that is not the global it means.
					 */
					define: { global: 'globalThis' },
					resolve: {
						preserveSymlinks: false,
						dedupe: ['effect', 'svelte'],
						alias: [
							{
								find: '@norbital-ai/bolt/authoring/internals',
								replacement: authoringInternalsEntry
							},
							{
								find: '@norbital-ai/bolt/authoring',
								replacement: authoringEntry
							},
							{
								find: '@norbital-ai/bolt/runtime',
								replacement: runtimeEntry
							},
							{
								find: '@norbital-ai/bolt/client-runtime',
								replacement: clientRuntimeEntry
							},
							{
								find: '@norbital-ai/bolt/client',
								replacement: clientEntry
							},
							{
								find: '@norbital-ai/bolt/host',
								replacement: hostEntry
							},
							{
								find: '@norbital-ai/bolt',
								replacement: rootEntry
							}
						]
					},
					build: {
						outDir: artifactDirectory,
						emptyOutDir: false,
						minify: false,
						rollupOptions: {
							input: artifactEntry,
							preserveEntrySignatures: 'strict',
							output: { entryFileNames: 'bundle.mjs', inlineDynamicImports: true }
						}
					}
				})
			);
			return {
				workspaceRoot: root,
				collectionNames,
				appNames,
				toolNames,
				envoyNames,
				automationNames,
				mcpServerNames,
				artifactPath,
				staticAssetCount: assets.length
			};
		});
	}
};
export const syncWorkspace = WorkspaceSynchronization.sync;
export const renderI18nMessages = WorkspaceCompiler.renderI18nMessages;
export const renderArtifact = WorkspaceCompiler.renderArtifact;
export const renderAuthoringTypes = WorkspaceCompiler.renderAuthoringTypes;
export const renderWorkspaceAuthoring = WorkspaceCompiler.renderWorkspaceAuthoring;
export const renderWorkspaceTypes = WorkspaceCompiler.renderTypes;
export const renderClientDeclaration = WorkspaceCompiler.renderClientDeclaration;
export const renderCollectionTypes = WorkspaceCompiler.renderCollectionTypes;
