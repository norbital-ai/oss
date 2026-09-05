import { Effect, Predicate, Schema } from 'effect';
import type { FacilityBindings } from './facilities.js';
import type { Activation, Invocation } from './invocation.js';
import { SyncChange } from './sync.js';
import { FacilityName, ProtocolVersion, WireError } from './wire.js';

/**
 * One file an artifact ships, described rather than carried.
 *
 * This used to be a `StaticAsset` with a `bytes: Uint8Array` field, and every one of those bytes was
 * base64 in the artifact's own source: a workspace that ships PGlite produced a 33 MB `bundle.mjs`
 * of which two single lines were 13.4 MB and 8.4 MB of encoded WebAssembly. An isolate had to parse
 * all of it before the first request, and every tenant held its own copy of bytes that were
 * byte-identical across all of them.
 *
 * So the manifest now carries the index and the bytes live beside it, one flat file per digest. The
 * digest is the only name a blob has, which is what makes two artifacts that ship the same PGlite
 * build share one file, and what lets a host re-verify what it is about to serve without trusting
 * the path it found it under.
 */
export const AssetIndexEntry = Schema.Struct({
	/**
	 * What this file answers to.
	 *
	 * A browser entry's path is the URL suffix a host serves it at (`/workspace.js`). A server
	 * entry's path is the exact key the guest's asset bridge is asked for
	 * (`node_modules/pdq-wasm/wasm/pdq.wasm`) — a declared name, never a filesystem path, because
	 * nothing inside the isolate may name a location on the host's disk.
	 */
	path: Schema.NonEmptyString,
	contentType: Schema.NonEmptyString,
	sha256: Schema.NonEmptyString,
	byteLength: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
}).annotate({ identifier: 'BoltAssetIndexEntry' });
export interface AssetIndexEntry extends Schema.Schema.Type<typeof AssetIndexEntry> {}

/**
 * The sidecar layout a compiled artifact is written in, named once for everyone who reads it.
 *
 * These constants live here rather than in the compiler because the compiler is not the only party
 * that has to agree on them: `bolt-server` resolves a blob beside the bundle it imported, and Colony
 * reads the index without evaluating the bundle at all. Both are forbidden from importing
 * `@norbital-ai/bolt`, so a string spelled in the compiler alone would have to be spelled again in
 * every host — which is how a layout drifts.
 *
 * Everything is relative to the directory holding `bundle.mjs`:
 *
 * ```text
 * .norbital/artifact/
 * ├── bundle.mjs          materialized ESM graph entry for local/self-hosted use
 * ├── code/*.mjs          materialized runtime, dependency, and tenant modules
 * ├── release.json        standalone manifest and verified ESM graph
 * └── assets/<sha256>     one flat object per distinct code, asset, or provenance digest
 * ```
 */
export const ARTIFACT_BUNDLE_FILE = 'bundle.mjs';
export const ARTIFACT_ASSET_DIRECTORY = 'assets';
/**
 * The host-readable release authority beside a compiled artifact.
 *
 * `bundle.mjs` is guest code and therefore cannot be the place a host learns which immutable
 * objects make up a release. This sidecar is decoded and every digest is verified before any guest
 * byte is evaluated.
 */
export const ARTIFACT_RELEASE_FILE = 'release.json';

/** One immutable object in the artifact's flat digest-addressed object directory. */
export const ArtifactObjectReference = Schema.Struct({
	path: Schema.NonEmptyString,
	role: Schema.Literals([
		'runtime',
		'dependency',
		'tenant',
		'browser-asset',
		'server-asset',
		'schema',
		'migration-lineage',
		'lockfile'
	]),
	sha256: Schema.NonEmptyString,
	byteLength: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
}).annotate({ identifier: 'BoltArtifactObjectReference' });
export interface ArtifactObjectReference extends Schema.Schema.Type<
	typeof ArtifactObjectReference
> {}

/** Exact ESM specifier resolved only to another verified graph node. */
export const ArtifactCodeImport = Schema.Struct({
	specifier: Schema.NonEmptyString,
	target: Schema.NonEmptyString
}).annotate({ identifier: 'BoltArtifactCodeImport' });
export interface ArtifactCodeImport extends Schema.Schema.Type<typeof ArtifactCodeImport> {}

/**
 * One independently executable module in the server code graph.
 *
 * `path` is the exact specifier other graph nodes import. The role is assigned from Rollup's module
 * provenance by the compiler, never inferred by a deployment host from a filename.
 */
export const ArtifactCodeChunk = Schema.Struct({
	path: Schema.NonEmptyString,
	role: Schema.Literals(['runtime', 'dependency', 'tenant']),
	sha256: Schema.NonEmptyString,
	byteLength: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
	imports: Schema.Array(ArtifactCodeImport),
	dynamicImports: Schema.Array(ArtifactCodeImport)
}).annotate({ identifier: 'BoltArtifactCodeChunk' });
export interface ArtifactCodeChunk extends Schema.Schema.Type<typeof ArtifactCodeChunk> {}

/**
 * The exact deterministic ESM module graph evaluated by an isolate.
 *
 * Every import names another chunk path and `entrypoint` names one chunk. `sha256` identifies the
 * canonical graph index; individual node digests verify executable bytes before compilation.
 */
export const ArtifactCodeGraph = Schema.Struct({
	format: Schema.Literal('esm-v1'),
	entrypoint: Schema.NonEmptyString,
	sha256: Schema.NonEmptyString,
	byteLength: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
	chunks: Schema.Array(ArtifactCodeChunk)
}).annotate({ identifier: 'BoltArtifactCodeGraph' });
export interface ArtifactCodeGraph extends Schema.Schema.Type<typeof ArtifactCodeGraph> {}

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

const canonicalJson = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	if (isRecord(value)) {
		return `{${Object.entries(value)
			.toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
			.join(',')}}`;
	}
	return JSON.stringify(value) ?? 'null';
};

/** Canonical graph-index bytes; its SHA-256 is `ArtifactCodeGraph.sha256`. */
export const canonicalArtifactCodeGraphIndexEncoding = (
	graph: Omit<ArtifactCodeGraph, 'sha256'>
): string => `${canonicalJson(graph)}\n`;

/** Pure structural refusals shared by deployment preflight and the isolate boundary. */
export const artifactCodeGraphRefusals = (graph: ArtifactCodeGraph): ReadonlyArray<string> => {
	const refusals: Array<string> = [];
	const paths = new Set<string>();
	for (const chunk of graph.chunks) {
		if (paths.has(chunk.path)) refusals.push(`duplicate chunk path: ${chunk.path}`);
		paths.add(chunk.path);
		if (chunk.dynamicImports.length > 0)
			refusals.push(`dynamic imports are unsupported: ${chunk.path}`);
		const specifiers = new Set<string>();
		for (const imported of chunk.imports) {
			if (specifiers.has(imported.specifier))
				refusals.push(`duplicate import specifier: ${chunk.path} ${imported.specifier}`);
			specifiers.add(imported.specifier);
		}
	}
	if (!paths.has(graph.entrypoint)) refusals.push(`missing entrypoint: ${graph.entrypoint}`);
	for (const chunk of graph.chunks) {
		for (const imported of chunk.imports) {
			if (!paths.has(imported.target))
				refusals.push(`missing import target: ${chunk.path} ${imported.target}`);
		}
	}
	const byteLength = graph.chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
	if (byteLength !== graph.byteLength)
		refusals.push(
			`graph byte length mismatch: expected ${graph.byteLength}, described ${byteLength}`
		);
	return refusals;
};

/** One authored migration in its immutable lineage order. */
export const ArtifactMigration = Schema.Struct({
	tag: Schema.NonEmptyString,
	statements: Schema.Array(Schema.NonEmptyString)
}).annotate({ identifier: 'BoltArtifactMigration' });
export interface ArtifactMigration extends Schema.Schema.Type<typeof ArtifactMigration> {}
export const ArtifactMigrationLineage = Schema.Array(ArtifactMigration).annotate({
	identifier: 'BoltArtifactMigrationLineage'
});
export interface ArtifactMigrationLineage extends Schema.Schema.Type<
	typeof ArtifactMigrationLineage
> {}

/** Build input identity which does not belong in executable guest code. */
export const ArtifactProvenance = Schema.Struct({
	lockfile: Schema.NullOr(
		Schema.Struct({
			path: Schema.NonEmptyString,
			role: Schema.Literal('lockfile'),
			sha256: Schema.NonEmptyString,
			byteLength: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
		})
	),
	toolchain: Schema.Record(Schema.String, Schema.NonEmptyString)
}).annotate({ identifier: 'BoltArtifactProvenance' });
export interface ArtifactProvenance extends Schema.Schema.Type<typeof ArtifactProvenance> {}

export const RealtimeOutput = Schema.Struct({
	frames: Schema.Array(
		Schema.Struct({
			cursor: Schema.NonEmptyString,
			kind: Schema.Literals(['binary', 'text']),
			bytes: Schema.Uint8Array
		})
	),
	nextCursor: Schema.optionalKey(Schema.String),
	close: Schema.optionalKey(
		Schema.Struct({ code: Schema.Number.check(Schema.isInt()), reason: Schema.String })
	)
}).annotate({ identifier: 'BoltRealtimeOutput' });
export interface RealtimeOutput extends Schema.Schema.Type<typeof RealtimeOutput> {}

const Count = Schema.Number.check(Schema.isInt());

/** Where a source puts the next-page token: a response header, or a place in the body. */
const pageTokenLocations = [
	Schema.Struct({ header: Schema.NonEmptyString }),
	Schema.Struct({ field: Schema.NonEmptyString }),
	Schema.Struct({ path: Schema.Array(Schema.NonEmptyString) })
] as const;
const PageTokenLocation = Schema.Union(pageTokenLocations);

/**
 * Where the resumption point comes from, including the one place a page token cannot come from:
 * `maxOf` is the greatest value of a field across the records just read, so it is a watermark for
 * the *next run* rather than a token that can advance a page within this one.
 */
const CursorLocation = Schema.Union([
	...pageTokenLocations,
	Schema.Struct({ maxOf: Schema.NonEmptyString })
]);

/** How a binding resumes: where the kept cursor is sent, and where the next one is read from. */
export const ManifestPullCursor = Schema.Struct({
	send: Schema.Union([
		Schema.Struct({ query: Schema.NonEmptyString }),
		Schema.Struct({ header: Schema.NonEmptyString })
	]),
	next: CursorLocation
}).annotate({ identifier: 'BoltManifestPullCursor' });
export interface ManifestPullCursor extends Schema.Schema.Type<typeof ManifestPullCursor> {}

/** How the source pages, in the four shapes the pull loop knows how to walk. */
export const ManifestPullPages = Schema.Union([
	Schema.Struct({
		style: Schema.Literal('page'),
		pageQuery: Schema.NonEmptyString,
		sizeQuery: Schema.optionalKey(Schema.NonEmptyString),
		size: Schema.optionalKey(Count),
		firstPage: Schema.optionalKey(Count),
		max: Schema.optionalKey(Count)
	}),
	Schema.Struct({
		style: Schema.Literal('offset'),
		offsetQuery: Schema.NonEmptyString,
		limitQuery: Schema.NonEmptyString,
		size: Count,
		max: Schema.optionalKey(Count)
	}),
	Schema.Struct({
		style: Schema.Literal('cursor'),
		query: Schema.NonEmptyString,
		next: PageTokenLocation,
		max: Schema.optionalKey(Count)
	}),
	Schema.Struct({ style: Schema.Literal('link-header'), max: Schema.optionalKey(Count) })
]);
export type ManifestPullPages = typeof ManifestPullPages.Type;

/**
 * One inbound binding, as a host reads it.
 *
 * This is the declaration half of an authored `+integrations.ts` binding — the half that survives
 * `JSON.stringify`. The other half is a live `Schema.Codec`, an identity closure and an optional
 * mapper, which cannot cross a manifest boundary and stay in the artifact's authored runtime.
 *
 * `schedule` is why this is published at all: without it a pull only ever runs when something
 * enqueues one by hand, and a host has no way to learn that the artifact wanted it run hourly.
 */
export const ManifestIntegrationBinding = Schema.Struct({
	name: Schema.NonEmptyString,
	/** Cron, in the host's scheduler. */
	schedule: Schema.NonEmptyString,
	method: Schema.Literals(['GET', 'POST']),
	path: Schema.NonEmptyString,
	cursor: Schema.optionalKey(ManifestPullCursor),
	pages: Schema.optionalKey(ManifestPullPages),
	/** The collection column the external key lands in — what makes a second run an update. */
	identityColumn: Schema.NonEmptyString
}).annotate({ identifier: 'BoltManifestIntegrationBinding' });
export interface ManifestIntegrationBinding extends Schema.Schema.Type<
	typeof ManifestIntegrationBinding
> {}

/** One integration a tenant runtime offers, named `<collection>.<integration>` as the workspace named it. */
export const ManifestIntegration = Schema.Struct({
	name: Schema.NonEmptyString,
	collection: Schema.NonEmptyString,
	receive: Schema.Array(ManifestIntegrationBinding)
}).annotate({ identifier: 'BoltManifestIntegration' });
export interface ManifestIntegration extends Schema.Schema.Type<typeof ManifestIntegration> {}

/** One ordered DDL statement carried by an immutable Preview. */
export const ManifestSchemaStep = Schema.Struct({
	id: Schema.NonEmptyString,
	sql: Schema.NonEmptyString
}).annotate({ identifier: 'BoltManifestSchemaStep' });
export interface ManifestSchemaStep extends Schema.Schema.Type<typeof ManifestSchemaStep> {}

/**
 * The exact schema plan compiled into an artifact.
 *
 * Studio reads this value from the candidate artifact rather than asking the currently routed
 * runtime what its schema is. That distinction is what makes a pre-release DDL review meaningful:
 * the old release cannot describe the database shape the candidate will apply.
 */
export const ManifestSchemaPlan = Schema.Struct({
	fingerprint: Schema.NonEmptyString,
	steps: Schema.Array(ManifestSchemaStep)
}).annotate({ identifier: 'BoltManifestSchemaPlan' });
export interface ManifestSchemaPlan extends Schema.Schema.Type<typeof ManifestSchemaPlan> {}

/**
 * Immutable schema facts an authored guest can state about its own release.
 *
 * There is deliberately no generation here. A generation is a fact about one tenant database's
 * migration history, not a fact an artifact can know or a browser may propose. The host joins these
 * release facts to the `TenantMatrix.schemaGeneration` it advanced after a verified migration.
 */
export const SyncSchemaFacts = Schema.Struct({
	cursor: Schema.Literal('xid-sequence'),
	/** Version of this description shape; independent of the artifact protocol version below. */
	version: Schema.Literal(1),
	fingerprint: Schema.NonEmptyString,
	minimumProtocolVersion: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
	/** SHA-256 of the canonical UTF-8 provisioning-step encoding documented by Bolt's compiler. */
	migrationDigest: Schema.NonEmptyString,
	/** Every materialized collection whose readers must be withdrawn at a schema boundary. */
	affectedCollections: Schema.Array(Schema.NonEmptyString)
}).annotate({ identifier: 'BoltSyncSchemaFacts' });
export interface SyncSchemaFacts extends Schema.Schema.Type<typeof SyncSchemaFacts> {}

/**
 * Version of the compiler-owned authoring manifest consumed by Workspace Studio.
 *
 * This is deliberately independent of the bundle protocol and workspace package versions. An old
 * release may remain runnable while its authoring projection is too old to inspect safely; Studio
 * fails that case closed and asks for a rebuild instead of reconstructing source paths.
 */
export const COMPILED_MANIFEST_VERSION = 2 as const;

/** Meaning carried by an artifact and resolved by the Bolt shell's shared navigation builder. */
export const ManifestDestination = Schema.Union([
	Schema.Struct({ kind: Schema.Literal('app'), name: Schema.NonEmptyString }),
	Schema.Struct({
		kind: Schema.Literal('system'),
		surface: Schema.Literals(['approvals', 'automations', 'data', 'envoys', 'environment']),
		selection: Schema.optionalKey(Schema.NonEmptyString)
	})
]).annotate({ identifier: 'BoltManifestDestination' });
export type ManifestDestination = typeof ManifestDestination.Type;

/** Distinguishes authored declarations from generated/runtime-owned manifest facts. */
export const ManifestOrigin = Schema.Literals(['authored', 'system']).annotate({
	identifier: 'BoltManifestOrigin'
});
export type ManifestOrigin = Schema.Schema.Type<typeof ManifestOrigin>;

const ManifestAuthoredEntryFields = {
	sourcePath: Schema.optionalKey(Schema.NonEmptyString),
	origin: Schema.optionalKey(ManifestOrigin)
} as const;
const ManifestHook = Schema.Struct({
	name: Schema.NonEmptyString,
	description: Schema.optionalKey(Schema.String),
	...ManifestAuthoredEntryFields
});
const ManifestPipeline = Schema.Struct({
	name: Schema.NonEmptyString,
	description: Schema.optionalKey(Schema.String),
	...ManifestAuthoredEntryFields
});
const ManifestStudioIntegrationBinding = Schema.Struct({
	name: Schema.NonEmptyString,
	direction: Schema.Literals(['receive', 'send']),
	method: Schema.Literals(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
	path: Schema.NonEmptyString,
	schedule: Schema.optionalKey(Schema.NonEmptyString),
	events: Schema.optionalKey(Schema.Array(Schema.Literals(['create', 'update', 'delete']))),
	targetCollection: Schema.optionalKey(Schema.NonEmptyString),
	source: Schema.NonEmptyString
});
const ManifestEnvoy = Schema.Struct({
	name: Schema.NonEmptyString,
	transport: Schema.NonEmptyString,
	audience: Schema.NonEmptyString,
	groupMessages: Schema.optionalKey(Schema.Literals(['disabled', 'mention_or_reply', 'all'])),
	delegation: Schema.Literals(['enabled', 'disabled']),
	...ManifestAuthoredEntryFields,
	destination: Schema.optionalKey(ManifestDestination)
});

/** Read-only compiler projection returned by `workspace.authoringManifest`. */
const WorkspaceAuthoringManifestShape = Schema.Struct({
	name: Schema.NonEmptyString,
	version: Schema.NonEmptyString,
	// Optional only so Studio can identify an older release and render one fail-closed state.
	compiledManifestVersion: Schema.optionalKey(Schema.Number),
	collections: Schema.Array(
		Schema.Struct({
			name: Schema.NonEmptyString,
			history: Schema.Boolean,
			hooks: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
			hookDeclarations: Schema.optionalKey(Schema.Array(ManifestHook)),
			description: Schema.optionalKey(Schema.String),
			icon: Schema.optionalKey(Schema.String),
			...ManifestAuthoredEntryFields,
			destination: Schema.optionalKey(ManifestDestination),
			pipelines: Schema.optionalKey(Schema.Array(ManifestPipeline)),
			fields: Schema.Array(
				Schema.Struct({
					name: Schema.NonEmptyString,
					type: Schema.NonEmptyString,
					required: Schema.Boolean,
					generated: Schema.Boolean,
					search: Schema.optionalKey(Schema.Boolean),
					values: Schema.optionalKey(Schema.Array(Schema.String)),
					customType: Schema.optionalKey(Schema.String),
					mimeTypes: Schema.optionalKey(Schema.Array(Schema.String))
				})
			),
			relations: Schema.Array(
				Schema.Struct({
					name: Schema.NonEmptyString,
					target: Schema.NonEmptyString,
					cardinality: Schema.NonEmptyString
				})
			)
		})
	),
	apps: Schema.Array(
		Schema.Struct({
			name: Schema.NonEmptyString,
			label: Schema.String,
			icon: Schema.optionalKey(Schema.String),
			description: Schema.optionalKey(Schema.String),
			banner: Schema.optionalKey(Schema.String),
			thumbnail: Schema.optionalKey(Schema.String),
			...ManifestAuthoredEntryFields,
			destination: Schema.optionalKey(ManifestDestination)
		})
	),
	appGroups: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				name: Schema.NonEmptyString,
				label: Schema.String,
				description: Schema.optionalKey(Schema.String),
				icon: Schema.optionalKey(Schema.String),
				defaultChild: Schema.optionalKey(Schema.String),
				...ManifestAuthoredEntryFields,
				destination: Schema.optionalKey(ManifestDestination)
			})
		)
	),
	policies: Schema.Array(
		Schema.Struct({
			name: Schema.NonEmptyString,
			description: Schema.String,
			...ManifestAuthoredEntryFields,
			destination: Schema.optionalKey(ManifestDestination),
			grants: Schema.Array(
				Schema.Struct({
					collection: Schema.NonEmptyString,
					action: Schema.Literals(['read', 'create', 'update', 'delete', 'history']),
					fields: Schema.optionalKey(Schema.Array(Schema.String)),
					dependencies: Schema.optionalKey(Schema.Array(Schema.String)),
					where: Schema.optionalKey(Schema.Json),
					approval: Schema.optionalKey(Schema.Boolean),
					authorization: Schema.optionalKey(Schema.Boolean)
				})
			),
			capabilities: Schema.Struct({
				apps: Schema.Array(Schema.String),
				tools: Schema.Array(Schema.String),
				mcp: Schema.Array(Schema.String),
				skills: Schema.Array(Schema.String)
			})
		})
	),
	automations: Schema.Array(
		Schema.Struct({
			name: Schema.NonEmptyString,
			description: Schema.optionalKey(Schema.String),
			...ManifestAuthoredEntryFields,
			destination: Schema.optionalKey(ManifestDestination),
			trigger: Schema.Union([
				Schema.Struct({ _tag: Schema.Literal('Manual') }),
				Schema.Struct({ _tag: Schema.Literal('Schedule'), cron: Schema.String }),
				Schema.Struct({
					_tag: Schema.Literal('Change'),
					collection: Schema.String,
					event: Schema.Literals(['created', 'updated', 'deleted'])
				})
			]),
			policies: Schema.Array(Schema.String)
		})
	),
	envoys: Schema.Array(ManifestEnvoy),
	integrations: Schema.Array(
		Schema.Struct({
			name: Schema.NonEmptyString,
			collection: Schema.optionalKey(Schema.String),
			description: Schema.optionalKey(Schema.String),
			...ManifestAuthoredEntryFields,
			bindings: Schema.optionalKey(Schema.Array(ManifestStudioIntegrationBinding))
		})
	),
	remotes: Schema.optionalKey(
		Schema.Array(Schema.Struct({ name: Schema.NonEmptyString, ...ManifestAuthoredEntryFields }))
	),
	environment: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				name: Schema.NonEmptyString,
				label: Schema.String,
				description: Schema.optionalKey(Schema.String),
				secret: Schema.Boolean,
				default: Schema.optionalKey(Schema.String),
				...ManifestAuthoredEntryFields,
				destination: Schema.optionalKey(ManifestDestination)
			})
		)
	),
	/**
	 * Every static identity this release can mint, with the label to render it as.
	 *
	 * `bolt_audit.subject_id` and `bolt_collection_history.subject_id` are plain `text` with no
	 * foreign key, so `envoy:support` and `automation:payroll_close` are valid authors with no
	 * shadow user row behind them — and a client holding one of those ids has nothing but the id to
	 * show unless the manifest names it. The runtime has always sent this list; the contract did not
	 * declare it, and `Schema.Struct` drops undeclared keys, so it was stripped on the way out.
	 */
	principals: Schema.Array(
		Schema.Struct({
			id: Schema.NonEmptyString,
			label: Schema.NonEmptyString,
			kind: Schema.Literals(['host', 'seed', 'envoy', 'automation']),
			policies: Schema.Array(Schema.String)
		})
	),
	requiredFacilities: Schema.Array(Schema.String)
});

const authoredManifestSourcePathProblem = (
	manifest: Schema.Schema.Type<typeof WorkspaceAuthoringManifestShape>
): string | undefined => {
	if (manifest.compiledManifestVersion !== COMPILED_MANIFEST_VERSION) return undefined;
	const missing: Array<string> = [];
	const requirePath = (
		kind: string,
		entry: Readonly<{
			readonly name: string;
			readonly origin?: ManifestOrigin;
			readonly sourcePath?: string;
		}>
	): void => {
		if (entry.origin === 'authored' && entry.sourcePath === undefined) {
			missing.push(`${kind}:${entry.name}`);
		}
	};
	for (const collection of manifest.collections) {
		requirePath('collection', collection);
		for (const hook of collection.hookDeclarations ?? []) requirePath('hook', hook);
		for (const pipeline of collection.pipelines ?? []) requirePath('pipeline', pipeline);
	}
	for (const app of manifest.apps) requirePath('app', app);
	for (const group of manifest.appGroups ?? []) requirePath('app-group', group);
	for (const policy of manifest.policies) requirePath('policy', policy);
	for (const automation of manifest.automations) requirePath('automation', automation);
	for (const envoy of manifest.envoys) requirePath('envoy', envoy);
	for (const integration of manifest.integrations) requirePath('integration', integration);
	for (const remote of manifest.remotes ?? []) requirePath('remote', remote);
	for (const environment of manifest.environment ?? []) requirePath('environment', environment);
	return missing.length === 0
		? undefined
		: `current compiled manifest is missing authored source paths for ${missing.join(', ')}`;
};

export const WorkspaceAuthoringManifest = WorkspaceAuthoringManifestShape.check(
	Schema.makeFilter((manifest) => authoredManifestSourcePathProblem(manifest))
).annotate({ identifier: 'BoltWorkspaceAuthoringManifest' });
export type WorkspaceAuthoringManifest = typeof WorkspaceAuthoringManifest.Type;

export const BundleManifest = Schema.Struct({
	protocolVersion: ProtocolVersion,
	/** Optional for runtime rollback of artifacts built before Studio's versioned projection. */
	compiledManifestVersion: Schema.optionalKey(Schema.Number),
	artifactId: Schema.NonEmptyString,
	artifactVersion: Schema.NonEmptyString,
	schemaFingerprint: Schema.NonEmptyString,
	schemaPlan: ManifestSchemaPlan,
	requiredFacilities: Schema.Array(FacilityName),
	/**
	 * What a host serves over HTTP, and what only the guest may read.
	 *
	 * Two lists rather than one with a flag, because the distinction is a permission and a permission
	 * that is a boolean on a shared list gets tested in one place and forgotten in the next. A
	 * `serverAssets` entry is a file the workspace declared for its own runtime — a WebAssembly module
	 * an authored hook instantiates — and `bolt-server` has no route that can reach one. Before this
	 * split those files were copied into the client output directory and swept into the same public
	 * asset set as `workspace.js`, so declaring a server-side dependency published it.
	 */
	browserAssets: Schema.Array(AssetIndexEntry),
	serverAssets: Schema.Array(AssetIndexEntry),
	/**
	 * What this artifact mirrors from the outside world, and when it wants each mirror refreshed.
	 *
	 * A required field, empty for a workspace that declares none, for the same reason
	 * `requiredFacilities` is: a host has to be able to tell "declares no integrations" from "was
	 * built before the manifest carried them", and an optional field cannot say that.
	 */
	integrations: Schema.Array(ManifestIntegration)
}).annotate({ identifier: 'BoltBundleManifest' });
export interface BundleManifest extends Schema.Schema.Type<typeof BundleManifest> {}

/** The two asset namespaces authorized only as part of a complete tenant release. */
const TenantReleaseAssets = Schema.Struct({
	browser: Schema.Array(AssetIndexEntry),
	server: Schema.Array(AssetIndexEntry)
});

/**
 * Standalone authority for one immutable tenant release.
 *
 * A host reads this JSON sidecar before it imports anything. Publication is valid only when every
 * referenced object hashes to its declared digest and the code graph index is complete and
 * internally resolvable. Runtime semantic validation remains the isolate's job:
 * this release authority deliberately contains no value obtained by importing or evaluating guest
 * code in the compiler or host process.
 */
export const TenantRelease = Schema.Struct({
	formatVersion: Schema.Literal(1),
	protocolVersion: ProtocolVersion,
	artifactId: Schema.NonEmptyString,
	artifactVersion: Schema.NonEmptyString,
	requiredFacilities: Schema.Array(FacilityName),
	code: ArtifactCodeGraph,
	assets: TenantReleaseAssets,
	schema: Schema.Struct({
		fingerprint: Schema.NonEmptyString,
		description: Schema.Struct({
			path: Schema.NonEmptyString,
			role: Schema.Literal('schema'),
			sha256: Schema.NonEmptyString,
			byteLength: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
		}),
		migrations: Schema.Struct({
			path: Schema.NonEmptyString,
			role: Schema.Literal('migration-lineage'),
			sha256: Schema.NonEmptyString,
			byteLength: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
		})
	}),
	provenance: ArtifactProvenance
}).annotate({ identifier: 'BoltTenantRelease' });
export interface TenantRelease extends Schema.Schema.Type<typeof TenantRelease> {}

/**
 * Canonical bytes whose SHA-256 is the release identity.
 *
 * The release id is intentionally not a field of `TenantRelease`: including a digest inside the
 * value it digests is recursive. Object keys are sorted, array order is semantic, and the trailing
 * newline is part of the encoding. Using the code graph digest alone is invalid because an asset,
 * schema, migration, or provenance-only release would collide with its predecessor.
 */
export const canonicalTenantReleaseEncoding = (release: TenantRelease): string => {
	return `${canonicalJson(release)}\n`;
};

/**
 * Flattens every authorized immutable object into the one preflight/upload vocabulary.
 *
 * Duplicate digests are retained here because roles are permissions: a byte may legitimately be
 * named by two paths, while a deploy can still deduplicate uploads by `sha256` alone.
 */
export const tenantReleaseObjects = (
	release: TenantRelease
): ReadonlyArray<ArtifactObjectReference> => [
	...release.code.chunks.map(({ path, role, sha256, byteLength }) => ({
		path,
		role,
		sha256,
		byteLength
	})),
	...release.assets.browser.map(({ path, sha256, byteLength }) => ({
		path,
		role: 'browser-asset' as const,
		sha256,
		byteLength
	})),
	...release.assets.server.map(({ path, sha256, byteLength }) => ({
		path,
		role: 'server-asset' as const,
		sha256,
		byteLength
	})),
	release.schema.description,
	release.schema.migrations,
	...(release.provenance.lockfile === null ? [] : [release.provenance.lockfile])
];

export const DispatchResponse = Schema.Struct({
	status: Schema.Number.check(Schema.isInt()),
	headers: Schema.Record(Schema.String, Schema.Array(Schema.String)),
	body: Schema.optionalKey(Schema.Uint8Array),
	value: Schema.optionalKey(Schema.Json),
	realtime: Schema.optionalKey(RealtimeOutput),
	/** Exact committed coordinates; a host feeds these directly to `sync.advance`. */
	changes: Schema.optionalKey(Schema.Array(SyncChange))
});
export interface DispatchResponse extends Schema.Schema.Type<typeof DispatchResponse> {}

export const BundleResult = Schema.TaggedUnion({
	Success: { response: DispatchResponse },
	Failure: { error: WireError }
});
export type BundleResult = typeof BundleResult.Type;

/**
 * One durable callback the artifact asks the host to hold on its behalf.
 *
 * A command name, and nothing else. It carried `schedule` and `input` as well, so that a host could
 * *originate* work rather than only route it — and that was the wrong side of the seam. A cron is
 * declared by a release, a release is read by the guest, and a host holding one had to learn cron
 * grammar to act on it. Schedules now live in the tenant's own `bolt_schedule`, where the party that
 * can read the declaration is also the party that acts on it, and the host is told one number
 * instead: the next instant anything is due.
 *
 * So this is back to what a host genuinely needs — where to send work addressed to this release.
 */
export const Registration = Schema.Struct({
	command: Schema.NonEmptyString
}).annotate({ identifier: 'BoltRegistration' });
export interface Registration extends Schema.Schema.Type<typeof Registration> {}

export const ActivationResult = Schema.TaggedUnion({
	Activated: {
		registrations: Schema.Array(Registration),
		/**
		 * When this workspace next has something to do, as the guest computed it while activating.
		 *
		 * `null` for a release that declares no schedule and has nothing queued — which is a real and
		 * common state, and the one where a host must arm no timer at all. That is the whole of what
		 * makes idle cost nothing: no heartbeat, no minimum interval, no liveness probe, and no query
		 * until this instant arrives or a request arrives first.
		 *
		 * It rides the activation answer rather than a message of its own because activation has just
		 * written the schedules and is already holding the connection that knows.
		 */
		nextDueAtEpochMs: Schema.Union([Schema.Number, Schema.Null])
	},
	Failure: { error: WireError }
});
export type ActivationResult = typeof ActivationResult.Type;

export type BoltBundle = Readonly<{
	readonly protocolVersion: ProtocolVersion;
	readonly manifest: BundleManifest;
	readonly dispatch: (
		invocation: Invocation,
		facilities: FacilityBindings,
		signal: AbortSignal
		// repository-health:allow EFF2 -- A dynamically imported bundle crosses an artifact/runtime boundary; both host entrypoints convert this promise into Effect immediately.
	) => Promise<BundleResult>;
	readonly activate: (
		activation: Activation,
		facilities: FacilityBindings,
		signal: AbortSignal
		// repository-health:allow EFF2 -- Activation uses the same dynamically imported artifact boundary and is converted into Effect by the host entrypoint.
	) => Promise<ActivationResult>;
}>;

/** Identifies structural or schema failures while validating a dynamically imported artifact module. */
export class BundleModuleError extends Schema.TaggedError<BundleModuleError>()(
	'BoltProtocol.BundleModuleError',
	{
		message: Schema.NonEmptyString,
		cause: Schema.optionalKey(Schema.Defect())
	}
) {
	readonly category = 'bundle-module' as const;
}

/** Validates the data and callable surface of an unknown dynamic import without a cast. */
export const decodeBoltBundleModule = Effect.fn('BoltProtocol.decodeBoltBundleModule')(function* (
	input: unknown
) {
	if (!Predicate.isObject(input)) {
		return yield* new BundleModuleError({ message: 'Bolt bundle module must be an object' });
	}
	const protocolVersion = yield* Schema.decodeUnknownEffect(ProtocolVersion)(
		input['protocolVersion']
	).pipe(
		Effect.mapError(
			(cause) => new BundleModuleError({ message: 'Unsupported Bolt protocol version', cause })
		)
	);
	const manifest = yield* Schema.decodeUnknownEffect(BundleManifest)(input['manifest']).pipe(
		Effect.mapError(
			(cause) => new BundleModuleError({ message: 'Invalid Bolt bundle manifest', cause })
		)
	);
	const dispatch = input['dispatch'];
	const activate = input['activate'];
	if (!Predicate.isFunction(dispatch) || !Predicate.isFunction(activate)) {
		return yield* new BundleModuleError({
			message: 'Bolt bundle module must export dispatch and activate functions'
		});
	}
	const bundle: BoltBundle = {
		protocolVersion,
		manifest,
		dispatch: (invocation, facilities, signal) => dispatch(invocation, facilities, signal),
		activate: (activation, facilities, signal) => activate(activation, facilities, signal)
	};
	return bundle;
});

/** Reports facilities required by the bundle but absent from the host bindings. */
export const missingFacilities = (
	manifest: BundleManifest,
	bindings: FacilityBindings
): ReadonlyArray<FacilityName> =>
	manifest.requiredFacilities.filter((name) => bindings[name] === undefined);
