import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { access, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, esbuildVersion, type Plugin, rolldownVersion, version as viteVersion } from 'vite';
import { init as moduleLexerReady, parse as parseModuleImports } from 'es-module-lexer';
import { Effect, Schema } from 'effect';
import {
	type AssetIndexEntry,
	COMPILED_MANIFEST_VERSION,
	PROTOCOL_VERSION,
	type TenantRelease
} from '@norbital-ai/bolt-protocol';
import { toError } from '@norbital-ai/std';
import {
	collection,
	type CollectionCatalogEntry,
	type CompiledAuthoring,
	type CompiledTenantCapabilities,
	McpRegistrationDefinition,
	type RelationDefinition,
	type WorkspaceMigrationEntry
} from '../authoring/workspace-schema.js';
import { platformCustomTypes } from '../authoring/models-schema.js';
import { SYSTEM_COLLECTION_MODELS } from '../authoring/system-models.js';
import {
	collectionCatalogEntry,
	compileModel,
	compileWorkspaceAuthoring
} from '../authoring/model-introspection.js';
import {
	ARTIFACT_ASSET_DIRECTORY,
	ARTIFACT_BUNDLE_FILE,
	ARTIFACT_DIRECTORY,
	ARTIFACT_RELEASE_FILE,
	BOLT_TENANT_REQUEST_PREFIX,
	BOLT_TENANT_STATIC_PREFIX,
	SERVER_ASSET_DECLARATION_FILE_NAME,
	WORKSPACE_ENTRY_FILE_NAME
} from './client-entry.js';
import { appCapabilityNames } from './compiler.js';
import { extractAppMetadata, extractGroupMetadata } from './app-metadata.js';
import {
	type EmittedServerChunk,
	readLockfileProvenance,
	readSchemaProvenance,
	serverModulePartition,
	writeTenantRelease
} from './artifact-release.js';

const boltPackageRoot = fileURLToPath(new URL('../..', import.meta.url));

export const tenantRuntimeBoundary = (): Plugin => ({
	name: '@norbital-ai/bolt:tenant-runtime-boundary',
	enforce: 'pre',
	resolveId(source, importer) {
		if (!isBuiltin(source)) return null;
		const owner = importer === undefined ? 'the tenant artifact entry' : importer;
		this.error(
			`Tenant runtime module ${owner} imports Node builtin ${JSON.stringify(source)}. ` +
				'Bolt artifacts run in a portable isolate; use a Web Platform API or move the operation behind a facility.'
		);
	}
});

/** Lowers literal dynamic imports through es-module-lexer's exact statement spans. */
export const lowerLiteralDynamicImports = async (code: string): Promise<string | null> => {
	if (!code.includes('import(')) return null;
	await moduleLexerReady;
	const imports = parseModuleImports(code)[0].flatMap((entry) =>
		entry.d >= 0 && entry.n !== undefined
			? [{ start: entry.ss, end: entry.se, source: entry.n }]
			: []
	);
	if (imports.length === 0) return null;
	const bindings = new Map<string, string>();
	const usedBindings = new Set<string>();
	for (const { source } of imports) {
		if (bindings.has(source)) continue;
		let suffix = bindings.size;
		let binding = `__bolt_static_import_${suffix}`;
		while (code.includes(binding) || usedBindings.has(binding))
			binding = `__bolt_static_import_${++suffix}`;
		bindings.set(source, binding);
		usedBindings.add(binding);
	}
	let transformed = code;
	for (const entry of imports.toSorted((left, right) => right.start - left.start)) {
		const binding = bindings.get(entry.source);
		if (binding === undefined) throw new Error(`Missing static import binding for ${entry.source}`);
		transformed = `${transformed.slice(0, entry.start)}Promise.resolve(${binding})${transformed.slice(entry.end)}`;
	}
	const declarations = [...bindings]
		.map(([source, binding]) => `import * as ${binding} from ${JSON.stringify(source)};`)
		.join('\n');
	return `${declarations}\n${transformed}`;
};

const closeServerModuleGraph = (): Plugin => ({
	name: '@norbital-ai/bolt:close-server-module-graph',
	transform: (code) =>
		lowerLiteralDynamicImports(code).then((lowered) =>
			lowered === null ? null : { code: lowered, map: null }
		)
});

const captureServerCodeGraph = (
	partitionInput: Parameters<typeof serverModulePartition>[1],
	receive: (chunks: ReadonlyArray<EmittedServerChunk>) => void
): Plugin => ({
	name: '@norbital-ai/bolt:server-code-graph',
	async generateBundle(_options, bundle) {
		await moduleLexerReady;
		const encoder = new TextEncoder();
		const containsDynamicImport = (code: string): boolean =>
			parseModuleImports(code)[0].some((entry) => entry.d >= 0);
		receive(
			Object.values(bundle).flatMap((output) => {
				if (output.type !== 'chunk') return [];
				if (output.dynamicImports.length > 0 || containsDynamicImport(output.code)) {
					this.error(
						`Tenant server module ${output.fileName} retains dynamic imports${output.dynamicImports.length === 0 ? '' : ` (${output.dynamicImports.join(', ')})`}. ` +
							'Isolate modules support only a closed static graph; import dependencies statically or move lazy loading behind a facility.'
					);
				}
				const roles = new Set(
					Object.keys(output.modules).flatMap((id) => {
						const partition = serverModulePartition(id, partitionInput);
						return partition === undefined ? [] : [partition.role];
					})
				);
				if (roles.size > 1) {
					this.error(
						`Tenant server module ${output.fileName} mixes compiler provenance roles: ${[...roles].toSorted().join(', ')}`
					);
				}
				const role = roles.values().next().value ?? (output.isEntry ? 'tenant' : undefined);
				if (role === undefined)
					this.error(`Tenant server module ${output.fileName} has no compiler provenance role`);
				return [
					{
						path: output.fileName,
						role,
						imports: output.imports,
						dynamicImports: output.dynamicImports,
						bytes: encoder.encode(output.code)
					} satisfies EmittedServerChunk
				];
			})
		);
	}
});

const fileExists = (path: string): Effect.Effect<boolean> =>
	Effect.tryPromise(() => access(path)).pipe(
		Effect.as(true),
		Effect.catch(() => Effect.succeed(false))
	);

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
	readonly releasePath: string;
	readonly releaseId: string;
	readonly browserAssetCount: number;
	readonly serverAssetCount: number;
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

const decodePackageMetadataFile = Schema.decodeUnknownSync(
	Schema.fromJsonString(PackageMetadataFile)
);
const decodeI18nMessagesFile = Schema.decodeUnknownSync(Schema.fromJsonString(I18nMessagesFile));
const decodeMcpRegistration = (input: unknown): McpRegistrationDefinition =>
	Schema.decodeUnknownSync(McpRegistrationDefinition)(input);

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
	readonly teamsImport: string | undefined;
}>;

type RenderedAppGroup = Readonly<{
	readonly name: string;
	readonly label?: string;
	readonly description?: string;
	readonly icon?: string;
	readonly defaultChild?: string;
	readonly sourcePath?: string;
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

export const systemCollectionCatalog = (): ReadonlyArray<CollectionCatalogEntry> =>
	Object.entries(SYSTEM_COLLECTION_MODELS).map(([name, declaration]) =>
		collectionCatalogEntry(compileModel(collection({ name, fields: {} }), declaration), [])
	);

type TenantReleaseAssets = TenantRelease['assets'];

const ServerAssetDeclaration = Schema.Struct({ targets: Schema.Array(Schema.NonEmptyString) });
const decodeServerAssetDeclaration = Schema.decodeUnknownEffect(
	Schema.fromJsonString(ServerAssetDeclaration)
);

type RenderArtifactInput = Readonly<{
	readonly metadata: PackageMetadata;
	readonly compiledAuthoring: CompiledAuthoring;
	readonly collectionHooks: ReadonlyArray<{
		readonly name: string;
		readonly path: string;
	}>;
	readonly apps: ReadonlyArray<{
		readonly name: string;
		readonly label: string;
		readonly icon?: string;
		readonly description?: string;
		readonly banner?: string;
		readonly thumbnail?: string;
		readonly sourcePath?: string;
	}>;
	readonly appGroups?: ReadonlyArray<RenderedAppGroup>;
	readonly policies: ReadonlyArray<string>;
	readonly functions: ReadonlyArray<string>;
	readonly toolFiles: ReadonlyArray<string>;
	readonly envoyFiles: ReadonlyArray<string>;
	readonly automations: ReadonlyArray<string>;
	readonly automationFiles: ReadonlyArray<string>;
	readonly pipelineFiles: ReadonlyArray<string>;
	readonly prompt: string;
	readonly root: string;
	readonly assetIndex: TenantReleaseAssets;
	readonly customTypeDefinitions: ReadonlyArray<string>;
	readonly migrations: ReadonlyArray<WorkspaceMigrationEntry>;
	readonly schemaFingerprint: string;
	readonly integrationFiles?: ReadonlyArray<string>;
	readonly environmentFile: string | undefined;
	readonly anonymousLimitFile?: string | undefined;
	readonly teamsFile?: string | undefined;
}>;

class WorkspaceCompiler {
	static readonly readPackageMetadata = (root: string) =>
		Effect.map(
			Effect.tryPromise(() => readFile(join(root, 'package.json'), 'utf8')),
			(source) => {
				const value = decodePackageMetadataFile(source);
				return {
					name: value.name ?? basename(root),
					version: value.version ?? '0.0.0-local',
					description: value.description ?? 'Bolt workspace'
				};
			}
		);

	static readonly filesUnder = (root: string) =>
		Effect.tryPromise({
			try: () => readdir(root, { withFileTypes: true, recursive: true }),
			catch: (cause) => toError(cause)
		}).pipe(
			Effect.catch((cause) =>
				Reflect.get(cause, 'code') === 'ENOENT'
					? Effect.succeed<Array<Dirent>>([])
					: Effect.fail(cause)
			),
			Effect.map((entries) =>
				entries.flatMap((entry) =>
					entry.isDirectory() ? [] : [join(entry.parentPath, entry.name)]
				)
			)
		);

	static readonly posix = (path: string): string => path.split(sep).join('/');
	static readonly sourceImport = (root: string, path: string): string =>
		`../../${WorkspaceCompiler.posix(relative(root, path)).replace(/\.(?:ts|svelte)$/, '.js')}`;
	static readonly runtimeSourceImport = (root: string, path: string): string =>
		`../../${WorkspaceCompiler.posix(relative(root, path))}`;
	static readonly quotedUnion = (values: ReadonlyArray<string>): string =>
		values.length === 0 ? 'never' : values.map((value) => JSON.stringify(value)).join(' | ');
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

	static readonly renderModels = (models: ReadonlyArray<string>, root: string): string => {
		const entries = models
			.map((path, index) => `\t${JSON.stringify(basename(dirname(path)))}: model${index}`)
			.join(',\n');
		return `import { defineModels } from '@norbital-ai/bolt/authoring/internals';\n${WorkspaceCompiler.importLines(models, root, 'model')}\n\nexport const models = defineModels({\n${entries}\n});\nexport type Models = typeof models;\n`;
	};

	static readonly renderCustomTypes = (
		definitions: ReadonlyArray<string>,
		root: string
	): string => {
		const entries = definitions
			.map((path, index) => `\t${JSON.stringify(basename(dirname(path)))}: definition${index}`)
			.join(',\n');
		return `import type { CustomTypeOutput } from '@norbital-ai/bolt/authoring';\nimport { platformCustomTypes } from '@norbital-ai/bolt/authoring';\n${WorkspaceCompiler.importLines(definitions, root, 'definition')}\n\nexport const customTypes = {\n\t...platformCustomTypes,\n${entries}\n} as const;\nexport type CustomKind = keyof typeof customTypes;\nexport type CustomValue<K extends CustomKind> = CustomTypeOutput<(typeof customTypes)[K]>;\n`;
	};

	static readonly renderI18nKeys = (messages: Readonly<Record<string, string>>): string => {
		const keys = Object.keys(messages).toSorted();
		return keys.length === 0
			? 'export type TenantI18nKeys = string;\n'
			: `export type TenantI18nKeys =\n${keys.map((key) => `\t| ${JSON.stringify(key)}`).join('\n')};\n`;
	};

	static readonly readI18nMessages = (root: string) => {
		const readLocale = (locale: 'en' | 'zh'): Effect.Effect<Readonly<Record<string, string>>> =>
			Effect.tryPromise(() =>
				readFile(join(root, 'src', 'i18n', `messages.${locale}.json`), 'utf8')
			).pipe(
				Effect.catch(() => Effect.succeed<string | undefined>(undefined)),
				Effect.map((source) => (source === undefined ? {} : decodeI18nMessagesFile(source)))
			);
		return Effect.map(Effect.all([readLocale('en'), readLocale('zh')] as const), ([en, zh]) => ({
			en,
			zh
		}));
	};

	static readonly renderI18nMessages = (catalogs: I18nCatalogs): string =>
		`export const tenantMessages = ${JSON.stringify({ en: catalogs.en, zh: catalogs.zh })};\n`;

	static readonly renderI18nMessagesDeclaration = (): string =>
		`export declare const tenantMessages: {\n\treadonly en: Readonly<Record<string, string>>;\n\treadonly zh: Readonly<Record<string, string>>;\n};\n`;

	static readonly renderCollectionCatalog = (
		entries: ReadonlyArray<CollectionCatalogEntry>,
		publicCollectionNames: ReadonlyArray<string> = entries.map((entry) => entry.name)
	): string => {
		const catalog = Object.fromEntries(entries.map((entry) => [entry.name, entry]));
		return `export const collectionCatalog = ${JSON.stringify(catalog)};\nexport const publicCollectionNames = ${JSON.stringify([...new Set(publicCollectionNames)])};\n`;
	};

	static readonly renderCollectionCatalogDeclaration = (): string =>
		`export declare const collectionCatalog: Readonly<Record<string, {\n\treadonly name: string;\n\treadonly recordLabel?: string;\n\treadonly fields: ReadonlyArray<{ readonly name: string; readonly kind: string; readonly array?: boolean; readonly nullable: boolean; readonly readOnly?: boolean; readonly search?: boolean; readonly values?: ReadonlyArray<string>; readonly currencies?: ReadonlyArray<string>; readonly precision?: 'day' | 'minute'; readonly mimeTypes?: ReadonlyArray<string>; readonly relation?: { readonly name: string; readonly target: string; readonly cardinality: 'one' | 'many' } }>;\n\treadonly relationships: ReadonlyArray<{ readonly name: string; readonly target: string; readonly cardinality: 'one' | 'many'; readonly cascade?: true }>;\n}>>;\nexport declare const publicCollectionNames: ReadonlyArray<string>;\n`;

	static readonly renderRelationTypes = (relations: ReadonlyArray<RelationDefinition>): string => {
		const byCollection = new Map<string, Array<string>>();
		for (const relation of relations) {
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

	static readonly renderRelationshipTypes = (): string =>
		`import type { PlatformRelationshipsFor } from '@norbital-ai/bolt/authoring/internals';\nimport type { Models } from '../../generated/models.js';\nexport type Relationships = PlatformRelationshipsFor<Models>;\n`;

	static readonly renderPolicyTypes = (): string =>
		`import type { PolicyDefinition } from '@norbital-ai/bolt/authoring';\nimport type { WorkspaceSchema } from '../../../generated/types.js';\nexport type { AppName, CollectionName, McpServerName, PolicyName, SkillName, TeamName, ToolName } from '../../../generated/authoring-types.js';\nexport type Policy = PolicyDefinition<WorkspaceSchema>;\n`;

	static readonly renderAccessTypes = (): string =>
		`export type { PolicyName, TeamName } from '../../generated/authoring-types.js';\nimport type { Teams as TeamsDeclaration } from '@norbital-ai/bolt/authoring';\nexport type Teams = TeamsDeclaration;\n`;

	static readonly renderEnvoyTypes = (): string =>
		`import type { EnvoyDefinition } from '@norbital-ai/bolt/authoring';\nexport type { EnvoyName, PolicyName } from '../../generated/authoring-types.js';\nexport type Envoy = EnvoyDefinition;\n`;

	static readonly renderHandlerTypes = (): string =>
		`import type { AutomationContext, AutomationTrigger } from '@norbital-ai/bolt/authoring/internals';\nimport type { WorkspaceSchema } from '../../generated/types.js';\nexport type { Api, WorkspaceRow } from '../../generated/types.js';\nexport type { AutomationName, CollectionName, FunctionName, PolicyName, ToolName } from '../../generated/authoring-types.js';\nexport type Trigger = AutomationTrigger<WorkspaceSchema>;\nexport type Scope<T extends Trigger> = AutomationContext<T, WorkspaceSchema>['scope'];\n`;

	static readonly renderCustomTypeRenderer = (definition: string, root: string): string => {
		const definitionImport = `../../../${WorkspaceCompiler.posix(relative(root, definition)).replace(/\.ts$/, '.js')}`;
		return `import type { CustomTypeOutput } from '@norbital-ai/bolt/authoring';\nimport type definition from ${JSON.stringify(definitionImport)};\nexport type CollectionField = { readonly name: string; readonly type: string };\nexport type Value = CustomTypeOutput<typeof definition>;\nexport type RendererProps =\n\t| { readonly mode: 'display'; readonly field: CollectionField; readonly value: Value | null }\n\t| { readonly mode: 'edit'; readonly field: CollectionField; readonly value: Value | null; readonly disabled: boolean; onValueChange(value: Value | null): void };\n`;
	};

	static readonly renderClientRuntimeDeclaration = (): string =>
		`declare module 'virtual:bolt/client-runtime' {\n\timport type { BrowserWorkspaceRuntimeOptions, CollectionCatalog, ErasedAutomationClientApi, SystemClientApi, WorkspaceClientRuntime } from '@norbital-ai/bolt/client-runtime';\n\texport function createBrowserWorkspaceRuntime(options?: BrowserWorkspaceRuntimeOptions): WorkspaceClientRuntime;\n\texport function createWorkspaceApiProxy(runtime: WorkspaceClientRuntime, catalog?: CollectionCatalog, visibility?: { readonly allowedCollections?: ReadonlyArray<string>; readonly readOnlyCollections?: ReadonlyArray<string>; readonly system?: boolean }): { readonly db: object; readonly automations: ErasedAutomationClientApi; readonly invoke: object; readonly collections: object; readonly system?: SystemClientApi };\n\t\t\t}\n`;

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
		return `import './app.css';\n// The workspace stylesheet rides this module, not the entry.\n//\n// Vite links an entry's CSS from the HTML document it generates, and this build generates no\n// document — so a sheet imported by the entry is emitted beside it and never loaded. A sheet\n// imported by a *dynamically* imported chunk is different: Vite's own preload helper inserts the\n// link before the chunk executes. This module is only ever reached through \`import('$bolt/client')\`\n// inside \`mountWorkspace\`, so the supported mechanism applies and nothing has to rewrite chunk\n// text to make the workspace render styled.\nexport { client } from './framework-client.js';\nexport const appLoaders = {\n${loaders}\n};\nexport const representationLoaders = {\n${representationLoaders}\n};\nexport const customTypeRendererLoaders = {\n${customRendererLoaders}\n};\nexport const appGroups = {\n${groupEntries}\n};\nexport const appMeta = ${JSON.stringify(appMeta)};\nexport const policyNames = ${JSON.stringify(policies)};\n`;
	};

	static readonly renderFrameworkClientRuntime = (schemaFingerprint: string): string =>
		`import { createBrowserWorkspaceRuntime, createWorkspaceApiProxy } from 'virtual:bolt/client-runtime';\nimport { collectionCatalog as publicCollectionCatalog, publicCollectionNames } from './collections.js';\nimport { collectionCatalog as frameworkCollectionCatalog } from './framework-collections.js';\nconst runtime = createBrowserWorkspaceRuntime({ schemaFingerprint: ${JSON.stringify(schemaFingerprint)} });\nexport const client = createWorkspaceApiProxy(runtime, publicCollectionCatalog, { allowedCollections: publicCollectionNames, readOnlyCollections: ['approval_request'], system: false });\nexport const frameworkClient = createWorkspaceApiProxy(runtime, frameworkCollectionCatalog);\nexport const syncStatus = runtime.syncStatus;\n`;

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
				exclude: [
					'../node_modules',
					'./dist',
					'../src/**/*.test.ts',
					'../src/**/*.spec.ts'
				]
			},
			null,
			'\t'
		);

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
		if (path.endsWith('.wasm')) return 'application/wasm';
		if (path.endsWith('.sql')) return 'text/plain; charset=utf-8';
		return 'application/octet-stream';
	};

	static readonly write = (path: string, content: string) =>
		Effect.gen(function* () {
			yield* Effect.tryPromise(() => mkdir(dirname(path), { recursive: true }));
			yield* Effect.tryPromise(() => writeFile(path, content, 'utf8'));
		});
}

export const buildAssetIndex = (
		root: string,
		workspaceKey: string,
		artifactDirectory: string,
		capabilities: CompiledTenantCapabilities = { skills: [], mcp: [] }
	) => {
		const blobDirectory = join(artifactDirectory, ARTIFACT_ASSET_DIRECTORY);
		const written = new Set<string>();
		const store = (path: string, key: string): Effect.Effect<AssetIndexEntry, Error> =>
			Effect.gen(function* () {
				const bytes = yield* Effect.tryPromise(() => readFile(path));
				const sha256 = createHash('sha256').update(bytes).digest('hex');
				if (!written.has(sha256)) {
					written.add(sha256);
					yield* Effect.tryPromise(() => writeFile(join(blobDirectory, sha256), bytes));
				}
				return {
					path: key,
					contentType: WorkspaceCompiler.contentType(path),
					sha256,
					byteLength: bytes.byteLength
				};
			});
		return Effect.gen(function* () {
			const dist = join(root, '.norbital', 'dist');
			const emitted = (yield* WorkspaceCompiler.filesUnder(dist)).toSorted();
			const declarationPath = join(dist, SERVER_ASSET_DECLARATION_FILE_NAME);
			const declared = (yield* fileExists(declarationPath))
				? (yield* decodeServerAssetDeclaration(
						yield* Effect.tryPromise(() => readFile(declarationPath, 'utf8'))
					).pipe(
						Effect.mapError(
							(cause) =>
								new Error(
									`The client build under ${dist} left an unreadable ${SERVER_ASSET_DECLARATION_FILE_NAME}: ${String(cause)}`
								)
						)
					)).targets
				: [];
			const built = emitted.filter((path) => path !== declarationPath);
			if (built.length === 0) {
				return yield* Effect.fail(
					new Error(
						`No compiled client under ${dist}. \`bolt sync\` builds it; an empty directory means that build produced no output.`
					)
				);
			}
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
			const emittedKeys = new Set(
				built.map((path) => WorkspaceCompiler.posix(relative(dist, path)))
			);
			const missing = declared.filter((target) => !emittedKeys.has(target));
			if (missing.length > 0) {
				return yield* Effect.fail(
					new Error(
						`The workspace declares server assets the client build did not copy into ${dist}: ${missing.join(', ')}. Check the \`serverAssets\` sources in vite.config.ts.`
					)
				);
			}
			const serverKeys = new Set(declared);
			const media = join(root, 'assets');
			const authored = (yield* WorkspaceCompiler.filesUnder(media)).toSorted();
			yield* Effect.tryPromise(() => rm(blobDirectory, { recursive: true, force: true }));
			yield* Effect.tryPromise(() => mkdir(blobDirectory, { recursive: true }));
			const capabilityDirectory = join(artifactDirectory, 'capabilities');
			const capabilityIndexPath = join(capabilityDirectory, 'index.json');
			yield* Effect.tryPromise(() => mkdir(capabilityDirectory, { recursive: true }));
			yield* Effect.tryPromise(() =>
				writeFile(
					capabilityIndexPath,
					`${JSON.stringify({
						format: 'norbital-capabilities-v1',
						skills: capabilities.skills.map(({ body: _body, ...skill }) => skill),
						mcp: capabilities.mcp
					})}\n`,
					'utf8'
				)
			);
			const capabilityAssets = yield* Effect.all(
				[
					store(capabilityIndexPath, 'capabilities/index.json'),
					...capabilities.skills.flatMap((skill) =>
						skill.files.map((file) =>
							Effect.gen(function* () {
								const entry = yield* store(
									join(root, 'src', 'capabilities', 'skills', skill.name, file.path),
									`capabilities/skills/${skill.name}/${file.path}`
								);
								if (entry.sha256 !== file.sha256 || entry.byteLength !== file.byteLength)
									return yield* Effect.fail(
										new Error(
											`Tenant skill ${skill.name}/${file.path} changed after capability compilation.`
										)
									);
								return entry;
							})
						)
					)
				],
				{ concurrency: 'unbounded' }
			);
			const [browser, server] = yield* Effect.all(
				[
					Effect.all(
						[
							...built
								.filter((path) => !serverKeys.has(WorkspaceCompiler.posix(relative(dist, path))))
								.map((path) => store(path, `/${WorkspaceCompiler.posix(relative(dist, path))}`)),
							...authored.map((path) =>
								store(
									path,
									`${BOLT_TENANT_REQUEST_PREFIX}/api/template-seed-assets/${workspaceKey}/${WorkspaceCompiler.posix(relative(media, path))}`
								)
							)
						],
						{ concurrency: 'unbounded' }
					),
					Effect.all(
						declared.toSorted().map((target) => store(join(dist, target), target)),
						{ concurrency: 'unbounded' }
					)
				] as const,
				{ concurrency: 'unbounded' }
			);
			return {
				browser,
				server: [...server, ...capabilityAssets].toSorted((left, right) =>
					left.path.localeCompare(right.path)
				)
			} satisfies TenantReleaseAssets;
		});
	};

export const renderAuthoringTypes = (input: RenderAuthoringTypesInput): string => {
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

export const renderWorkspaceTypes = (
	relations: ReadonlyArray<RelationDefinition> = []
): string =>
	`import type { Api as AuthoringApi, SchemaQueryConfig, SchemaQueryRow } from '@norbital-ai/bolt/authoring';\nimport type { TablesForModels } from '@norbital-ai/bolt/authoring/internals';\nimport type { Models } from './models.js';\n\ntype WorkspaceTables = TablesForModels<Models>;\ntype WorkspaceRelations = ${WorkspaceCompiler.renderRelationTypes(relations)};\nexport type WorkspaceSchema = { readonly tables: WorkspaceTables; readonly relations: WorkspaceRelations };\nexport type Api = AuthoringApi<WorkspaceSchema>;\nexport type WorkspaceRow<N extends keyof WorkspaceSchema['tables'] & string, Cfg extends SchemaQueryConfig<WorkspaceSchema, N> | undefined = undefined> = SchemaQueryRow<WorkspaceSchema, N, Cfg>;\n`;

export const renderCollectionTypes = (name: string): string =>
	`import type { CollectionHooks, CollectionIntegrations, CollectionPipelines } from '@norbital-ai/bolt/authoring';\nimport type { WorkspaceRow, WorkspaceSchema } from '../../../generated/types.js';\nexport type { Api, WorkspaceRow } from '../../../generated/types.js';\nexport type Row = WorkspaceRow<${JSON.stringify(name)}>;\nexport type RepresentationProps = { readonly record: Row | null; close(): void };\nexport type Hooks<Prepared = void> = CollectionHooks<WorkspaceSchema, ${JSON.stringify(name)}, Prepared>;\nexport type Pipelines = CollectionPipelines<WorkspaceSchema, ${JSON.stringify(name)}>;\nexport type Integrations = CollectionIntegrations<WorkspaceSchema, ${JSON.stringify(name)}>;\n`;

export const renderWorkspaceAuthoring = (): string =>
	`import type { AppName, AutomationName, CollectionName, DatatypeName, EnvoyName, FunctionName, McpServerName, PolicyName, SkillName, TeamName, ToolName } from '../generated/authoring-types.js';\nimport type { WorkspaceSchema } from '../generated/types.js';\ndeclare module '@norbital-ai/bolt/authoring' { interface WorkspaceAuthoringTypes { readonly schema: WorkspaceSchema; readonly collectionName: CollectionName; readonly policyName: PolicyName; readonly appName: AppName; readonly toolName: ToolName; readonly mcpServerName: McpServerName; readonly skillName: SkillName; readonly envoyName: EnvoyName; readonly automationName: AutomationName; readonly functionName: FunctionName; readonly datatypeName: DatatypeName } interface WorkspaceTeamAuthoringTypes { readonly teamName: TeamName } }\nexport {};\n`;

export const renderClientDeclaration = (
	functions: ReadonlyArray<string>,
	root: string,
	automations: ReadonlyArray<string> = []
): string => {
	const entries = (paths: ReadonlyArray<string>): string =>
		paths
			.map(
				(path) =>
					`\treadonly ${JSON.stringify(basename(path).slice(1, -3))}: typeof import(${JSON.stringify(WorkspaceCompiler.sourceImport(root, path))}).default;`
			)
			.join('\n');
	return `import type { CollectionRegistryFor, InvokeClientApi, PublicPlatformSchema } from '@norbital-ai/bolt/authoring/internals';\nimport type { AutomationClientApi } from '@norbital-ai/bolt/client-runtime';\nimport type { CollectionClient } from '@norbital-ai/std/collection';\nimport type { CollectionSurface } from '@norbital-ai/ui/collection-runtime';\nimport type { CustomTypeRenderer } from '@norbital-ai/ui/data-renderer';\nimport type { Component } from 'svelte';\nimport type { WorkspaceSchema } from './types.js';\ntype AutomationRegistry = {\n${entries(automations)}\n};\ntype TenantCollections = CollectionRegistryFor<WorkspaceSchema>;\ntype PlatformCollections = CollectionRegistryFor<PublicPlatformSchema>;\ntype Collections = TenantCollections & PlatformCollections;\ntype BaseClient = CollectionClient<Collections>;\ntype PublicCollectionName = keyof Collections & string;\ntype TenantDatabase = { readonly [N in keyof TenantCollections]: CollectionClient<TenantCollections>['db'][N] };\ntype PlatformDatabase = { readonly [N in Exclude<keyof PlatformCollections, keyof TenantCollections>]: Omit<CollectionClient<PlatformCollections>['db'][N], 'mutate' | 'pending'> };\ntype PublicRecords = { readonly findMany: (collectionName: PublicCollectionName, query?: Parameters<BaseClient['records']['findMany']>[1]) => ReturnType<BaseClient['records']['findMany']> };\ntype PublicHistory = { readonly findMany: (collectionName: PublicCollectionName, recordId: string, limit?: number) => ReturnType<NonNullable<BaseClient['history']>['findMany']> };\ntype Invoke = {\n${entries(functions)}\n};\nexport type { WorkspaceRow } from './types.js';\nexport type WorkspaceCollections = Collections;\nexport type WorkspaceMutation<N extends keyof TenantCollections> = TenantCollections[N]['mutation'];\nexport type Client = Omit<BaseClient, 'db' | 'records' | 'history'> & { readonly db: TenantDatabase & PlatformDatabase; readonly records: PublicRecords; readonly history?: PublicHistory; readonly automations: AutomationClientApi<AutomationRegistry>; readonly invoke: InvokeClientApi<Invoke> };\nexport declare const client: Client;\nexport declare const appLoaders: Readonly<Record<string, () => Promise<Component>>>;\nexport declare const representationLoaders: Readonly<Record<string, () => Promise<NonNullable<CollectionSurface['representation']>>>>;\nexport declare const customTypeRendererLoaders: Readonly<Record<string, () => Promise<CustomTypeRenderer>>>;\nexport declare const appGroups: Readonly<Record<string, { readonly defaultChild?: string; readonly label?: string; readonly description?: string; readonly icon?: string }>>;\nexport declare const appMeta: Readonly<Record<string, { readonly label?: string; readonly icon?: string; readonly description?: string; readonly banner?: string; readonly thumbnail?: string }>>;\nexport declare const policyNames: ReadonlyArray<string>;\n`;
};

const renderArtifactImports = (imports: ReadonlyArray<string>): string =>
	[
		"import { buildManifest, makeBundle } from '@norbital-ai/bolt/runtime';",
		"import { describeEnvoy, describeHooks, describeIntegrations, describePolicy, manifestIntegrations } from '@norbital-ai/bolt/authoring/internals';",
		...imports
	]
		.filter((line) => line !== '')
		.join('\n');

const renderCompiledDeclarations = (input: {
	readonly policyEntries: string;
	readonly hookEntries: string;
	readonly customTypeEntries: string;
	readonly envoyEntries: string;
	readonly pipelineEntries: string;
	readonly integrationEntries: string;
	readonly automationEntries: string;
	readonly workspace: unknown;
	readonly environmentEntry: string;
	readonly rateLimitEntry: string;
	readonly teamsEntry: string;
}): string => `const authoredPolicies = {${input.policyEntries}};
const policies = Object.entries(authoredPolicies).map(([name, declaration]) => describePolicy(name, declaration));
const declaredHooks = {${input.hookEntries}};
const declaredCustomTypes = { ...platformCustomTypes, ${input.customTypeEntries} };
const declaredEnvoys = {${input.envoyEntries}};
const declaredPipelines = {${input.pipelineEntries}};
const declaredIntegrationModules = {${input.integrationEntries}};
const describedIntegrations = describeIntegrations(declaredIntegrationModules);
const declaredAutomations = Object.fromEntries([${input.automationEntries}].map((automation) => [automation.name, automation]));
const declaredWorkspace = ${JSON.stringify(input.workspace, null, 2)};
const collections = declaredWorkspace.collections.map((collection) => {
	const hooks = describeHooks(declaredHooks[collection.name]);
	return hooks.length === 0 ? collection : { ...collection, hooks };
});
const envoys = declaredWorkspace.envoys.map(({ name }) => describeEnvoy(name, declaredEnvoys[name]));
const automations = declaredWorkspace.automations.map((automation) => ({ ...automation, ...(declaredAutomations[automation.name] === undefined ? {} : { trigger: declaredAutomations[automation.name].trigger, policies: declaredAutomations[automation.name].policies }) }));
const workspace = { ...declaredWorkspace, collections, envoys, automations, policies, customTypes: declaredCustomTypes, integrations: describedIntegrations.declarations${input.environmentEntry}${input.rateLimitEntry}${input.teamsEntry} };`;

const renderArtifactManifest = (input: {
	readonly metadata: PackageMetadata;
	readonly facilities: ReadonlyArray<string>;
	readonly assets: TenantReleaseAssets;
}): string => `const browserAssets = ${JSON.stringify(input.assets.browser)};
const serverAssets = ${JSON.stringify(input.assets.server)};
const manifestValue = { ...buildManifest(workspace, { artifactId: ${JSON.stringify(`${input.metadata.name}:local`)} }), requiredFacilities: ${JSON.stringify(input.facilities)}, browserAssets, serverAssets, integrations: manifestIntegrations(describedIntegrations.declarations) };`;

const renderArtifactHandlers = (remoteEntries: string, toolEntries: string): string =>
	`const remoteHandlers = {\n\t${remoteEntries}\n};
const toolHandlers = {\n\t${toolEntries}\n};
const authoredRuntime = { hooks: declaredHooks, pipelines: declaredPipelines, automations: declaredAutomations, integrations: describedIntegrations.authored };`;

const renderArtifactExports = (): string => `const bundle = makeBundle(workspace, manifestValue, remoteHandlers, toolHandlers, authoredRuntime);
export const protocolVersion = bundle.protocolVersion;
export const manifest = bundle.manifest;
export const dispatch = bundle.dispatch;
export const activate = bundle.activate;
export default bundle;
`;

export const renderArtifact = (input: RenderArtifactInput): string => {
		const {
			metadata,
			compiledAuthoring,
			collectionHooks,
			apps,
			policies,
			functions,
			toolFiles,
			envoyFiles,
			automations,
			automationFiles,
			pipelineFiles,
			appGroups = [],
			prompt,
			root,
			assetIndex,
			customTypeDefinitions,
			environmentFile,
			migrations,
			schemaFingerprint,
			integrationFiles = [],
			anonymousLimitFile,
			teamsFile
		} = input;
		const { collections, relationships: relations } = compiledAuthoring;
		const functionNames = functions.map((path) => basename(path).slice(1, -3));
		const policyNames = policies.map((path) => basename(path).slice(1, -3));
		const tools = toolFiles.map((path) => basename(path).slice(1, -3));
		const envoys = envoyFiles.map((path) => basename(path).slice(1, -3));
		const hasMcp = compiledAuthoring.capabilities.mcp.length > 0;
		const authoredTools = tools.map((name) => ({
			name,
			description: `Workspace tool ${name}`,
			command: `workspace:${name}`
		}));
		const requiredFacilities = hasMcp
			? (['database', 'ai', 'tasks', 'files', 'hostTools', 'connector'] as const)
			: (['database', 'ai', 'tasks', 'files', 'hostTools'] as const);
		const manifestFacilities = hasMcp
			? (['ai', 'connector', 'database', 'tasks'] as const)
			: (['ai', 'database', 'tasks'] as const);
		const relativeSourcePath = (path: string): string =>
			WorkspaceCompiler.posix(relative(root, path));
		const manifestProjection = {
			compiledManifestVersion: COMPILED_MANIFEST_VERSION,
			appGroups: appGroups.map(({ name, label, description, icon, defaultChild, sourcePath }) => ({
				name,
				...(label === undefined ? {} : { label }),
				...(description === undefined ? {} : { description }),
				...(icon === undefined ? {} : { icon }),
				...(defaultChild === undefined ? {} : { defaultChild }),
				...(sourcePath === undefined ? {} : { sourcePath })
			})),
			policySourcePaths: Object.fromEntries(
				policies.map((path) => [basename(path).slice(1, -3), relativeSourcePath(path)])
			),
			remoteSourcePaths: Object.fromEntries(
				functions.map((path) => [basename(path).slice(1, -3), relativeSourcePath(path)])
			),
			envoySourcePaths: Object.fromEntries(
				envoyFiles.map((path) => [basename(path).slice(1, -3), relativeSourcePath(path)])
			),
			automationSourcePaths: Object.fromEntries(
				automationFiles.map((path) => [basename(path).slice(1, -3), relativeSourcePath(path)])
			),
			hookSourcePaths: Object.fromEntries(
				collectionHooks.map(({ name, path }) => [name, relativeSourcePath(path)])
			),
			pipelineSourcePaths: Object.fromEntries(
				pipelineFiles.map((path) => [basename(dirname(path)), relativeSourcePath(path)])
			),
			integrationSourcePaths: Object.fromEntries(
				integrationFiles.map((path) => [basename(dirname(path)), relativeSourcePath(path)])
			),
			...(environmentFile === undefined
				? {}
				: { environmentSourcePath: relativeSourcePath(environmentFile) })
		};
		const workspace = {
			name: metadata.name,
			version: metadata.version,
			collections,
			relations,
			apps: apps.map((app) => ({
				name: app.name,
				label: app.label,
				...(app.icon === undefined ? {} : { icon: app.icon }),
				...(app.description === undefined ? {} : { description: app.description }),
				...(app.banner === undefined ? {} : { banner: app.banner }),
				...(app.thumbnail === undefined ? {} : { thumbnail: app.thumbnail }),
				...(app.sourcePath === undefined ? {} : { sourcePath: app.sourcePath }),
				destination: { kind: 'app' as const, name: app.name }
			})),
			policies: [],
			prompt,
			tools: authoredTools,
			skills: compiledAuthoring.capabilities.skills.map(({ name, body }) => ({ name, body })),
			automations: automations.map((name) => ({
				name,
				trigger: { _tag: 'Schedule', cron: '0 * * * *' },
				command: name,
				policies: []
			})),
			envoys: envoys.map((name) => ({ name })),
			integrations: [],
			requiredFacilities,
			migrations,
			schemaFingerprint,
			manifestProjection
		};
		const hookImports = collectionHooks
			.map(
				(collection, index) =>
					`import hooks${index} from ${JSON.stringify(WorkspaceCompiler.sourceImport(root, collection.path))};`
			)
			.join('\n');
		const hookEntriesByCollection = collectionHooks
			.map((collection, index) => `${JSON.stringify(collection.name)}: hooks${index}`)
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
		const schemaImport =
			functions.length === 0 && toolFiles.length === 0 ? [] : ["import { Schema } from 'effect';"];
		const toolImports = [...schemaImport, ...authoredToolImports].join('\n');
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
		const pipelineEntriesByCollection = pipelineFiles
			.map((path, index) => `${JSON.stringify(basename(dirname(path)))}: pipelines${index}`)
			.join(', ');
		const automationEntries = automations
			.map(
				(name, index) =>
					`{ name: ${JSON.stringify(name)}, description: automation${index}.spec.description, trigger: typeof automation${index}.trigger.schedule === 'string' ? { _tag: 'Schedule', cron: automation${index}.trigger.schedule } : automation${index}.trigger.trigger === undefined ? { _tag: 'Manual' } : { _tag: 'Change', collection: automation${index}.trigger.trigger.collection, event: automation${index}.trigger.trigger.event }, policies: automation${index}.spec.policies, ...(automation${index}.spec.input === undefined ? {} : { input: automation${index}.spec.input }), ...(automation${index}.spec.output === undefined ? {} : { output: automation${index}.spec.output }), handler: automation${index}.spec.handler }`
			)
			.join(', ');
		const envoyImports = envoyFiles
			.map(
				(path, index) =>
					`import envoy${index} from ${JSON.stringify(WorkspaceCompiler.sourceImport(root, path))};`
			)
			.join('\n');
		const envoyEntries = envoyFiles
			.map((path, index) => `${JSON.stringify(envoys[index])}: envoy${index}`)
			.join(', ');
		const customTypeImports = [
			"import { platformCustomTypes } from '@norbital-ai/bolt/authoring';",
			...customTypeDefinitions.map(
				(path, index) =>
					`import customType${index} from ${JSON.stringify(WorkspaceCompiler.sourceImport(root, path))};`
			)
		].join('\n');
		const integrationImports = integrationFiles
			.map(
				(path, index) =>
					`import integrations${index} from ${JSON.stringify(WorkspaceCompiler.sourceImport(root, path))};`
			)
			.join('\n');
		const integrationEntries = integrationFiles
			.map((path, index) => `${JSON.stringify(basename(dirname(path)))}: integrations${index}`)
			.join(', ');
		const rateLimitImport =
			anonymousLimitFile === undefined
				? ''
				: `import declaredAnonymousLimits from ${JSON.stringify(WorkspaceCompiler.sourceImport(root, anonymousLimitFile))};`;
		const rateLimitEntry =
			anonymousLimitFile === undefined ? '' : ', rateLimits: declaredAnonymousLimits';
		const teamsImport =
			teamsFile === undefined
				? ''
				: `import declaredTeams from ${JSON.stringify(WorkspaceCompiler.sourceImport(root, teamsFile))};`;
		const declaredTeamsEntry = teamsFile === undefined ? '' : ', teams: declaredTeams';
		const teamsEntry = declaredTeamsEntry;
		const environmentImport =
			environmentFile === undefined
				? ''
				: `import declaredEnvironment from ${JSON.stringify(WorkspaceCompiler.sourceImport(root, environmentFile))};`;
		const environmentEntry =
			environmentFile === undefined ? '' : ', environment: declaredEnvironment';
		const customTypeEntries = customTypeDefinitions
			.map((path, index) => `${JSON.stringify(basename(dirname(path)))}: customType${index}`)
			.join(', ');
		const policyEntries = policies
			.map((_, index) => `${JSON.stringify(policyNames[index])}: policy${index}`)
			.join(', ');
		const functionEntries = functions
			.map(
				(path, index) =>
					`${JSON.stringify(basename(path).slice(1, -3))}: (input, api) => fn${index}.handler(Schema.decodeUnknownSync(fn${index}.schema)(input), api)`
			)
			.join(',\n\t');
		const toolEntries = toolFiles
			.map(
				(path, index) =>
					`${JSON.stringify(basename(path).slice(1, -3))}: (input, api) => tool${index}.run(api, Schema.decodeUnknownSync(tool${index}.input)(input))`
			)
			.join(',\n\t');
		return [
			renderArtifactImports([
				hookImports,
				policyImports,
				functionImports,
				toolImports,
				automationImports,
				pipelineImports,
				envoyImports,
				customTypeImports,
				integrationImports,
				environmentImport,
				rateLimitImport,
				teamsImport
			]),
			renderCompiledDeclarations({
				policyEntries,
				hookEntries: hookEntriesByCollection,
				customTypeEntries,
				envoyEntries,
				pipelineEntries: pipelineEntriesByCollection,
				integrationEntries,
				automationEntries,
				workspace,
				environmentEntry,
				rateLimitEntry,
				teamsEntry
			}),
			renderArtifactManifest({ metadata, facilities: manifestFacilities, assets: assetIndex }),
			renderArtifactHandlers(functionEntries, toolEntries),
			renderArtifactExports()
		].join('\n');
	};

export const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

const migrationStatements = (source: string): ReadonlyArray<string> =>
	source
		.split(STATEMENT_BREAKPOINT)
		.map((part) => part.trim())
		.filter((part) => part !== '');

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
				Effect.map(
					Effect.tryPromise(() => readFile(join(migrationsRoot, tag, 'migration.sql'), 'utf8')),
					(source) => ({ tag, statements: migrationStatements(source) })
				)
			),
			{ concurrency: 'unbounded' }
		);
	});

const capabilityName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const skillRoots = new Set(['references', 'scripts', 'assets']);
const capabilityDigest = (value: unknown): string =>
	createHash('sha256').update(JSON.stringify(value)).digest('hex');

const skillMetadata = (path: string, source: string): { name: string; description: string } => {
	const lines = source.replace(/\r\n/g, '\n').split('\n');
	if (lines[0] !== '---') throw new TypeError(`${path} must begin with YAML frontmatter.`);
	const end = lines.indexOf('---', 1);
	if (end < 0) throw new TypeError(`${path} has unterminated YAML frontmatter.`);
	const values = new Map<string, string>();
	for (const line of lines.slice(1, end)) {
		const separator = line.indexOf(':');
		if (separator < 1) continue;
		const key = line.slice(0, separator).trim();
		let value = line.slice(separator + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		)
			value = value.slice(1, -1);
		values.set(key, value);
	}
	const name = values.get('name');
	const description = values.get('description');
	if (name === undefined || description === undefined || description === '')
		throw new TypeError(`${path} frontmatter must declare non-empty name and description fields.`);
	return { name, description };
};

const listCapabilityDirectories = (directory: string) =>
	Effect.tryPromise({
		try: () => readdir(directory, { withFileTypes: true }),
		catch: (cause) => toError(cause)
	}).pipe(
		Effect.catch((cause) =>
			Reflect.get(cause, 'code') === 'ENOENT'
				? Effect.succeed<Array<Dirent>>([])
				: Effect.fail(cause)
		)
	);

const compileSkillPackages = (
	workspaceRoot: string,
	relativeRoot: string
): Effect.Effect<CompiledTenantCapabilities['skills'], Error> =>
	Effect.gen(function* () {
		const packagesRoot = join(workspaceRoot, ...relativeRoot.split('/'));
		const packages = yield* listCapabilityDirectories(packagesRoot);
		if (packages.length > 64)
			return yield* Effect.fail(new Error('A workspace may ship at most 64 tenant skill packages.'));
		return yield* Effect.all(
			packages
				.toSorted((left, right) => left.name.localeCompare(right.name))
				.map((entry) =>
					Effect.gen(function* () {
						const authored = `${relativeRoot}/${entry.name}`;
						if (!entry.isDirectory() || !capabilityName.test(entry.name) || entry.name.length > 64)
							return yield* Effect.fail(
								new Error(`${authored} must be a lower-kebab-case skill directory.`)
							);
						const packageRoot = join(packagesRoot, entry.name);
						const paths = (yield* WorkspaceCompiler.filesUnder(packageRoot)).toSorted();
						if (paths.length === 0 || !paths.includes(join(packageRoot, 'SKILL.md')))
							return yield* Effect.fail(new Error(`${authored} must contain SKILL.md.`));
						if (paths.length > 256)
							return yield* Effect.fail(
								new Error(`Tenant skill ${entry.name} may contain at most 256 files.`)
							);
						let packageBytes = 0;
						const files = yield* Effect.all(
							paths.map((path) =>
								Effect.gen(function* () {
									const relativePath = WorkspaceCompiler.posix(relative(packageRoot, path));
									const [top] = relativePath.split('/');
									if (
										relativePath === '' ||
										relativePath.startsWith('../') ||
										relativePath.includes('\\') ||
										relativePath.includes('\0') ||
										(relativePath !== 'SKILL.md' && (top === undefined || !skillRoots.has(top)))
									)
										return yield* Effect.fail(
											new Error(
												`Tenant skill ${entry.name} contains unsupported path ${relativePath}.`
											)
										);
									const status = yield* Effect.tryPromise(() => lstat(path));
									if (status.isSymbolicLink() || !status.isFile())
										return yield* Effect.fail(
											new Error(
												`Tenant skill ${entry.name} contains a non-regular file at ${relativePath}.`
											)
										);
									const bytes = yield* Effect.tryPromise(() => readFile(path));
									if (bytes.byteLength > 1024 * 1024)
										return yield* Effect.fail(
											new Error(`Tenant skill ${entry.name}/${relativePath} exceeds 1 MiB.`)
										);
									packageBytes += bytes.byteLength;
									return {
										path: relativePath,
										sha256: createHash('sha256').update(bytes).digest('hex'),
										byteLength: bytes.byteLength
									};
								})
							),
							{ concurrency: 'unbounded' }
						);
						if (packageBytes > 8 * 1024 * 1024)
							return yield* Effect.fail(
								new Error(`Tenant skill ${entry.name} exceeds 8 MiB in total.`)
							);
						const source = yield* Effect.tryPromise(() =>
							readFile(join(packageRoot, 'SKILL.md'), 'utf8')
						);
						const metadata = skillMetadata(`${authored}/SKILL.md`, source);
						if (metadata.name !== entry.name)
							return yield* Effect.fail(
								new Error(
									`Tenant skill directory ${entry.name} disagrees with frontmatter name ${metadata.name}.`
								)
							);
						const semantic = { name: entry.name, description: metadata.description, files };
						return { ...semantic, body: source, digest: capabilityDigest(semantic) };
					})
				),
			{ concurrency: 'unbounded' }
		);
	});

export const compileTenantCapabilities = (
	workspaceRoot: string,
	mcpFiles: ReadonlyArray<string>
): Effect.Effect<CompiledTenantCapabilities, Error> =>
	Effect.gen(function* () {
		const root = resolve(workspaceRoot);
		const skills = yield* compileSkillPackages(root, 'src/capabilities/skills');
		const mcp = yield* Effect.all(
			mcpFiles.toSorted().map((path) =>
				Effect.gen(function* () {
					const name = basename(path).slice(1, -3);
					if (!capabilityName.test(name) || name.length > 64)
						return yield* Effect.fail(new Error(`MCP registration ${name} is not lower-kebab-case.`));
					const source = yield* Effect.tryPromise(() => readFile(path));
					const sourceDigest = createHash('sha256').update(source).digest('hex');
					const loaded = yield* Effect.tryPromise(() =>
						import(`${pathToFileURL(path).href}?bolt-mcp=${sourceDigest}`)
					);
					const authored = loaded.default;
					const forbidden = ['protocol', 'transport', 'tools', 'schemas', 'command', 'args'].filter(
						(key) => typeof authored === 'object' && authored !== null && Object.hasOwn(authored, key)
					);
					if (forbidden.length > 0)
						return yield* Effect.fail(
							new Error(`MCP registration ${name} cannot declare ${forbidden.join(', ')}.`)
						);
					const declaration = yield* Effect.try({
						try: () => decodeMcpRegistration(authored),
						catch: (cause) =>
							cause instanceof Error ? cause : new Error(`Invalid MCP registration ${name}: ${String(cause)}`)
					});
					const semantic = {
						name,
						protocol: '2026-07-28' as const,
						transport: { kind: 'streamable-http' as const, endpoint: declaration.endpoint },
						...(declaration.authentication === undefined
							? {}
							: { authentication: declaration.authentication })
					};
					return { ...semantic, digest: capabilityDigest(semantic) };
				})
			),
			{ concurrency: 'unbounded' }
		);
		return { skills, mcp };
	});

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

		const definitions = files
			.filter(
				(path) =>
					basename(path) === '+definition.ts' &&
					compiler.posix(dirname(dirname(path))) === compiler.posix(join(sourceRoot, 'datatypes'))
			)
			.sort();
		const datatypeNames = definitions.map((path) => basename(dirname(path)));
		const shadowed = datatypeNames.filter((name) => name in platformCustomTypes);
		if (shadowed.length > 0) {
			return yield* Effect.fail(
				new Error(
					`Bolt sync found ${shadowed.length} datatype${shadowed.length === 1 ? '' : 's'} that redeclare${shadowed.length === 1 ? 's' : ''} a platform-owned type:\n  - src/datatypes/${shadowed.join('\n  - src/datatypes/')}/+definition.ts\n\nThe platform already owns ${shadowed.join(', ')}. Use ${shadowed.map((name) => `custom(${JSON.stringify(name)})`).join(' or ')} instead of declaring the datatype, and delete the directory. A datatype may only declare a name the platform does not own; discovery is the only difference between platform and tenant definitions.`
				)
			);
		}
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
		const representationFiles = files
			.filter(
				(path) =>
					basename(path) === '+representation.svelte' &&
					compiler.posix(path).includes('/collections/')
			)
			.sort();
		const customRendererFiles = files
			.filter(
				(path) =>
					basename(path) === '+renderer.svelte' &&
					compiler.posix(dirname(dirname(path))) === compiler.posix(join(sourceRoot, 'datatypes'))
			)
			.sort();
		const environmentFile = files.find(
			(path) => basename(path) === '+env.ts' && dirname(path) === sourceRoot
		);
		const promptFile = files.find(
			(path) => basename(path) === '+agents.md' && dirname(path) === sourceRoot
		);
		const anonymousLimitFile = files.find(
			(path) => basename(path) === '+anonymous_limits.ts' && inDirectory(path, 'access')
		);
		const teamsFile = files.find(
			(path) => basename(path) === '+teams.ts' && inDirectory(path, 'access')
		);
		const hookFiles = files.filter((path) => basename(path) === '+hooks.ts').sort();
		const pipelineFiles = files.filter((path) => basename(path) === '+pipelines.ts').sort();
		const integrationFiles = files
			.filter(
				(path) =>
					basename(path) === '+integrations.ts' && compiler.posix(path).includes('/collections/')
			)
			.sort();
		const toolFiles = declaredIn('capabilities/tools');
		const toolNames = namesOf(toolFiles);
		const mcpFiles = declaredIn('capabilities/mcp');
		const mcpServerNames = namesOf(mcpFiles);
		const envoyFiles = declaredIn('envoys');
		const envoyNames = namesOf(envoyFiles);
		const automationFiles = declaredIn('automations');
		const automationNames = namesOf(automationFiles);
		const groupFiles = files
			.filter((path) => basename(path) === '+group.ts' && compiler.posix(path).includes('/apps/'))
			.sort();
		const groupNames = groupFiles.map((path) =>
			compiler.posix(relative(join(sourceRoot, 'apps'), dirname(path)))
		);
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
						'  a tool, MCP, or tenant skill  capabilities/tools|mcp|skills/',
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
			groupFiles,
			groupNames
		};
	});
};

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
				groupFiles
			} = yield* discoverAuthoredSource(workspaceRoot);
			const {
				importWorkspaceModels,
				importWorkspaceRelationships,
				validateWorkspaceMigrationLineage
			} = yield* Effect.tryPromise({
				try: () => import('./schema-migrations.js'),
				catch: toError
			});
			const authoredModels = yield* importWorkspaceModels(models);
			const authoredRelationships = yield* importWorkspaceRelationships(
				join(root, 'src', 'collections', '+relationship.ts')
			);
			const capabilities = yield* compileTenantCapabilities(root, mcpFiles);
			const compiledAuthoring = compileWorkspaceAuthoring({
				models: authoredModels,
				sourcePaths: Object.fromEntries(
					models.map((path) => [basename(dirname(path)), compiler.posix(relative(root, path))])
				),
				relationships: authoredRelationships,
				capabilities,
				customTypeNames: datatypeNames
			});
			const relations = compiledAuthoring.relationships;
			const { schemaFingerprint } = yield* validateWorkspaceMigrationLineage({
				workspaceRoot: root,
				authoring: compiledAuthoring
			});
			const metadata = yield* compiler.readPackageMetadata(root);
			const compilerMetadata = yield* compiler.readPackageMetadata(boltPackageRoot);
			const i18nMessages = yield* compiler.readI18nMessages(root);
			const generated = join(root, '.norbital', 'generated');
			const types = join(root, '.norbital', 'types');
			const collectionCatalog = compiledAuthoring.collections.map((entry) =>
				collectionCatalogEntry(entry, relations)
			);
			const appMetaEntries = yield* Effect.all(
				appFiles.map((path) =>
					Effect.map(
						Effect.tryPromise(() => readFile(path, 'utf8')),
						(source) => {
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
						}
					)
				),
				{ concurrency: 'unbounded' }
			);
			const appMeta = Object.fromEntries(appMetaEntries);
			yield* Effect.all(
				[
					Effect.tryPromise({
						try: () => rm(generated, { recursive: true, force: true }),
						catch: toError
					}),
					Effect.tryPromise({
						try: () => rm(types, { recursive: true, force: true }),
						catch: toError
					})
				],
				{ concurrency: 'unbounded' }
			);
			const groupEntries = yield* Effect.all(
				groupFiles.map((path) =>
					Effect.map(
						Effect.tryPromise(() => readFile(path, 'utf8')),
						(source) => {
							const meta = extractGroupMetadata(source);
							const name = compiler.posix(relative(join(root, 'src', 'apps'), dirname(path)));
							return {
								name,
								...(meta.label === null ? {} : { label: meta.label }),
								...(meta.description === null ? {} : { description: meta.description }),
								...(meta.icon === null ? {} : { icon: meta.icon }),
								...(meta.defaultChild === null ? {} : { defaultChild: meta.defaultChild }),
								sourcePath: compiler.posix(relative(root, path))
							};
						}
					)
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
						renderAuthoringTypes({
							collections: collectionNames,
							apps: appNames,
							policies,
							functions,
							tools: toolNames,
							envoys: envoyNames,
							mcpServers: capabilities.mcp.map(({ name }) => name),
							skills: capabilities.skills.map(({ name }) => name),
							datatypes: [...Object.keys(platformCustomTypes), ...datatypeNames].toSorted(),
							automations: automationNames,
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
						compiler.renderCollectionCatalog(
							[
								...systemCollectionCatalog().filter((entry) => entry.name === 'approval_request'),
								...collectionCatalog
							],
							[...collectionCatalog.map((entry) => entry.name), 'approval_request']
						)
					),
					compiler.write(
						join(generated, 'framework-collections.js'),
						compiler.renderCollectionCatalog([...systemCollectionCatalog(), ...collectionCatalog])
					),
					compiler.write(
						join(generated, 'collections.d.ts'),
						compiler.renderCollectionCatalogDeclaration()
					),
					compiler.write(join(generated, 'app.css'), compiler.renderWorkspaceStylesheet()),
					compiler.write(join(generated, 'types.ts'), renderWorkspaceTypes(relations)),
					compiler.write(
						join(generated, 'client.d.ts'),
						renderClientDeclaration(functionFiles, root, automationFiles)
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
						join(generated, 'framework-client.js'),
						compiler.renderFrameworkClientRuntime(schemaFingerprint)
					),
					compiler.write(
						join(types, 'custom-type-values.d.ts'),
						compiler.renderCustomAugmentation(definitions, root)
					),
					compiler.write(
						join(types, 'workspace-authoring.d.ts'),
						renderWorkspaceAuthoring()
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
							renderCollectionTypes(name)
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
			if (!(yield* fileExists(join(root, 'vite.config.ts')))) {
				return yield* Effect.fail(
					new Error(
						`No vite.config.ts in ${root}. \`bolt sync\` builds the workspace client through it, so a materialized tree must carry it alongside package.json.`
					)
				);
			}
			yield* Effect.tryPromise({
				try: () => build({ root, base: './', mode: 'production', logLevel: 'warn' }),
				catch: (cause) =>
					cause instanceof Error
						? cause
						: new Error(`Workspace client build failed: ${String(cause)}`)
			});
			const artifactDirectory = join(root, ARTIFACT_DIRECTORY);
			const artifactEntry = join(artifactDirectory, 'bundle-entry.mjs');
			const artifactPath = join(artifactDirectory, ARTIFACT_BUNDLE_FILE);
			yield* Effect.tryPromise(() => rm(artifactDirectory, { recursive: true, force: true }));
			const assetIndex = yield* buildAssetIndex(
				root,
				metadata.name.split('/').at(-1) ?? metadata.name,
				artifactDirectory,
				capabilities
			);
			const appDescriptors = yield* Effect.all(
				appFiles.map((path, index) =>
					Effect.map(
						Effect.tryPromise(() => readFile(path, 'utf8')),
						(source) => {
							const meta = extractAppMetadata(source);
							const name =
								appNames[index] ?? compiler.posix(relative(join(root, 'src', 'apps'), path));
							return {
								name,
								label: meta.title ?? name,
								...(meta.icon === null ? {} : { icon: meta.icon }),
								...(meta.description === null ? {} : { description: meta.description }),
								...(meta.banner === null ? {} : { banner: meta.banner }),
								...(meta.thumbnail === null ? {} : { thumbnail: meta.thumbnail }),
								sourcePath: compiler.posix(relative(root, path))
							};
						}
					)
				),
				{ concurrency: 'unbounded' }
			);
			const collectionHooks = hookFiles.map((path) => ({
				name: basename(dirname(path)),
				path
			}));
			const migrations = yield* readWorkspaceMigrations(root);
			yield* compiler.write(
				artifactEntry,
				renderArtifact({
					metadata,
					compiledAuthoring,
					collectionHooks,
					apps: appDescriptors,
					appGroups: groupEntries,
					policies: policyFiles,
					functions: functionFiles,
					toolFiles,
					envoyFiles,
					automations: automationNames,
					automationFiles,
					pipelineFiles,
					prompt,
					root,
					assetIndex,
					customTypeDefinitions: definitions,
					environmentFile,
					migrations,
					schemaFingerprint,
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
			const partitionInput = {
				workspaceRoot: root,
				platformPackagesRoot: dirname(boltPackageRoot),
				artifactEntry
			};
			let serverCodeChunks: ReadonlyArray<EmittedServerChunk> = [];
			yield* Effect.tryPromise(() =>
				Promise.all([
					rm(artifactPath, { force: true }),
					rm(join(artifactDirectory, 'code'), { recursive: true, force: true })
				])
			);
			yield* Effect.tryPromise({
				try: () => build({
					root,
					configFile: false,
					plugins: [
						tenantRuntimeBoundary(),
						closeServerModuleGraph(),
						captureServerCodeGraph(partitionInput, (chunks) => {
							serverCodeChunks = chunks;
						})
					],
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
							preserveEntrySignatures: 'allow-extension',
							output: {
								strictExecutionOrder: true,
								entryFileNames: 'bundle.mjs',
								chunkFileNames: 'code/[name].mjs',
								codeSplitting: {
									includeDependenciesRecursively: false,
									groups: [
										{
											name: (id) => serverModulePartition(id, partitionInput)?.name ?? null
										}
									]
								}
							}
						}
					}
				}),
				catch: toError
			});
			if (serverCodeChunks.length === 0)
				return yield* Effect.fail(new Error('Server build emitted no executable code graph'));
			const lockfile = yield* Effect.tryPromise(() => readLockfileProvenance(root));
			const schema = yield* Effect.tryPromise(() => readSchemaProvenance(root, migrations));
			const builtRelease = yield* Effect.tryPromise(() =>
				writeTenantRelease(artifactDirectory, {
					protocolVersion: PROTOCOL_VERSION,
					artifactId: `${metadata.name}:local`,
					artifactVersion: metadata.version,
					requiredFacilities:
						capabilities.mcp.length === 0
							? ['ai', 'database', 'tasks']
							: ['ai', 'connector', 'database', 'tasks'],
					assets: assetIndex,
					schema: {
						...schema,
						fingerprint: schemaFingerprint
					},
					migrations,
					code: { entrypoint: ARTIFACT_BUNDLE_FILE, chunks: serverCodeChunks },
					lockfile,
					toolchain: {
						bolt: compilerMetadata.version,
						esbuild: esbuildVersion,
						node: process.versions.node,
						protocol: String(PROTOCOL_VERSION),
						rolldown: rolldownVersion,
						vite: viteVersion
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
				mcpServerNames: capabilities.mcp.map(({ name }) => name),
				artifactPath,
				releasePath: join(artifactDirectory, ARTIFACT_RELEASE_FILE),
				releaseId: builtRelease.releaseId,
				browserAssetCount: assetIndex.browser.length,
				serverAssetCount: assetIndex.server.length
			};
		});
	}
};
export const syncWorkspace = WorkspaceSynchronization.sync;
