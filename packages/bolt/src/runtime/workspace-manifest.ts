import { Schema } from 'effect';
import { describeEnvironment } from '#lib/authoring/environment-schema.js';
import type { AuthoredCollectionModule } from '#lib/authoring/collection-schema.js';
import type { WorkspaceDefinition } from '#lib/authoring/workspace-schema.js';
import type { AuthoredRuntime } from '#lib/runtime/collections/authored.js';

const jsonObject = (
	entry: Readonly<Record<string, Schema.Json | undefined>>
): Readonly<Record<string, Schema.Json>> => {
	const value: Record<string, Schema.Json> = {};
	for (const [key, field] of Object.entries(entry)) {
		if (field !== undefined) value[key] = field;
	}
	return value;
};

const isNumber = Schema.is(Schema.Number);
const isObjectLike = Schema.is(
	Schema.Union([Schema.Record(Schema.String, Schema.Unknown), Schema.Array(Schema.Unknown)])
);

const property = (value: unknown, key: string): unknown =>
	isObjectLike(value) ? Reflect.get(value, key) : undefined;

const text = (value: unknown): string | undefined =>
	typeof value === 'string' && value !== '' ? value : undefined;

const sourcePathFor = (projection: unknown, registry: string, name: string): string | undefined =>
	text(property(property(projection, registry), name));

/**
 * Provenance for one manifest entry, derived from whether a source file was actually resolved.
 *
 * `origin: 'authored'` is a claim that a studio can open the declaration's file, and the protocol
 * enforces it: `WorkspaceAuthoringManifest` rejects any manifest carrying an authored entry with no
 * `sourcePath`. Every registry below used to stamp `'authored'` unconditionally, which was false for
 * the three built-in policies `withSystemCollections` merges into every workspace — they are runtime
 * declarations with no file — so `workspace.manifest` failed its own response contract in every
 * tenant. A declaration whose path the compiler never recorded is a runtime-owned fact, which is
 * precisely what `'system'` means, and what the collection projection below already said.
 */
const provenance = (sourcePath: string | undefined): Readonly<Record<string, Schema.Json>> =>
	sourcePath === undefined ? { origin: 'system' } : { sourcePath, origin: 'authored' };

const entries = (value: unknown): ReadonlyArray<readonly [string, unknown]> =>
	isObjectLike(value) ? Object.entries(value) : [];

const authoredWriteEntries = (
	module: AuthoredCollectionModule | undefined,
	sourcePath: string | undefined
): ReadonlyArray<Readonly<Record<string, Schema.Json>>> => {
	if (module === undefined) return [];
	const declarations: Array<Readonly<Record<string, Schema.Json>>> = [];
	for (const operation of ['create', 'update', 'delete'] as const)
		if (module[operation] !== undefined)
			declarations.push(jsonObject({ name: operation, ...provenance(sourcePath) }));
	// repository-health:allow GUARD2 -- an authored transform is a function inside a dynamically loaded declaration module; no schema can recognize one.
	if (typeof module.transform === 'function')
		declarations.push(jsonObject({ name: 'transform', ...provenance(sourcePath) }));
	return declarations;
};

const authoredPipelineEntries = (
	module: unknown,
	sourcePath: string | undefined
): ReadonlyArray<Readonly<Record<string, Schema.Json>>> =>
	(['import', 'export'] as const).flatMap((direction) => {
		const declaration = property(module, direction);
		// repository-health:allow GUARD2 -- an authored import/export pipeline handler is a function inside a dynamically loaded declaration module; no schema can recognize one.
		return typeof property(declaration, 'handler') !== 'function'
			? []
			: [
					jsonObject({
						name: `collections.${direction}`,
						description: text(property(declaration, 'description')),
						...provenance(sourcePath)
					})
				];
	});

const integrationEntries = (
	definition: WorkspaceDefinition,
	projection: unknown
): ReadonlyArray<Readonly<Record<string, Schema.Json>>> =>
	definition.integrations.map((integration) => {
		const sourcePath = sourcePathFor(projection, 'integrationSourcePaths', integration.collection);
		return jsonObject({
			name: integration.name,
			collection: integration.collection,
			...provenance(sourcePath),
			bindings: [
				...integration.receive.map((binding) =>
					jsonObject({
						name: binding.name,
						direction: 'receive',
						method: binding.method,
						path: binding.path,
						schedule: binding.schedule,
						targetCollection: integration.collection,
						source: integration.name
					})
				),
				...integration.webhooks.map((binding) =>
					jsonObject({
						name: binding.name,
						direction: 'receive',
						method: 'POST',
						path: binding.path,
						targetCollection: integration.collection,
						source: integration.name
					})
				),
				...integration.send.map((binding) =>
					jsonObject({
						name: binding.name,
						direction: 'send',
						method: binding.method,
						path: binding.path,
						events: [...binding.events],
						source: integration.collection
					})
				)
			]
		});
	});

const appGroups = (projection: unknown): ReadonlyArray<Readonly<Record<string, Schema.Json>>> => {
	const groups = property(projection, 'appGroups');
	if (!Array.isArray(groups)) return [];
	return groups.flatMap((group) => {
		const name = text(property(group, 'name'));
		if (name === undefined) return [];
		return [
			jsonObject({
				name,
				label: text(property(group, 'label')) ?? name,
				description: text(property(group, 'description')),
				icon: text(property(group, 'icon')),
				defaultChild: text(property(group, 'defaultChild')),
				...provenance(text(property(group, 'sourcePath'))),
				destination: { kind: 'app', name }
			})
		];
	});
};

/** Projects compiler-owned provenance and executed declaration facts without runtime path guesses. */
export const authoredManifestDeclarations = (
	definition: WorkspaceDefinition,
	authoredRuntime: AuthoredRuntime
) => {
	const projection = property(definition, 'manifestProjection');
	const projectedVersion = property(projection, 'compiledManifestVersion');
	return {
		...(isNumber(projectedVersion) ? { compiledManifestVersion: projectedVersion } : {}),
		collections: definition.collections.map((collection) => ({
			name: collection.name,
			history: collection.history,
			writes: authoredWriteEntries(
				authoredRuntime.collections[collection.name],
				sourcePathFor(projection, 'collectionSourcePaths', collection.name)
			),
			pipelines: authoredPipelineEntries(
				authoredRuntime.pipelines[collection.name],
				sourcePathFor(projection, 'pipelineSourcePaths', collection.name)
			),
			...jsonObject({
				description: collection.description,
				icon: collection.icon,
				...provenance(collection.sourcePath)
			}),
			fields: Object.entries(collection.fields).map(([name, field]) =>
				jsonObject({
					name,
					type: field.type,
					required: field.required,
					generated: field.generated !== undefined,
					values: field.values === undefined ? undefined : [...field.values],
					search: field.search,
					customType: field.customType,
					mimeTypes: field.mimeTypes === undefined ? undefined : [...field.mimeTypes]
				})
			),
			relations: definition.relations
				.filter((relation) => relation.source === collection.name)
				.map(({ name, target, cardinality }) => ({ name, target, cardinality }))
		})),
		apps: definition.apps.map((app) =>
			jsonObject({
				name: app.name,
				label: app.label,
				icon: app.icon,
				description: app.description,
				banner: app.banner,
				thumbnail: app.thumbnail,
				...(app.kiosk === true ? { kiosk: true } : {}),
				...provenance(text(property(app, 'sourcePath'))),
				destination: { kind: 'app', name: app.name }
			})
		),
		appGroups: appGroups(projection),
		policies: definition.policies.map((policy) =>
			jsonObject({
				name: policy.name,
				description: policy.description ?? '',
				...provenance(sourcePathFor(projection, 'policySourcePaths', policy.name)),
				destination:
					policy.grants?.some((grant) => grant.approval !== undefined) === true
						? { kind: 'system', surface: 'approvals' }
						: undefined,
				grants: (policy.grants ?? []).map((grant) =>
					jsonObject({
						collection: grant.collection,
						action: grant.action,
						fields: grant.fields === undefined ? undefined : [...grant.fields],
						// Declared by the contract and by `RuntimePolicyGrant`, and dropped here — a studio
						// showing a grant's reach had no way to name the linking collections it declared.
						dependencies: grant.dependencies === undefined ? undefined : [...grant.dependencies],
						where:
							grant.where === undefined
								? undefined
								: Schema.decodeUnknownSync(Schema.Json)(grant.where),
						approval: grant.approval === undefined ? undefined : true,
						authorization: grant.authorization === undefined ? undefined : true
					})
				),
				capabilities: {
					apps: [...(policy.capabilities?.apps ?? [])],
					tools: [...(policy.capabilities?.tools ?? [])],
					mcp: [...(policy.capabilities?.mcp ?? [])],
					skills: [...(policy.capabilities?.skills ?? [])]
				}
			})
		),
		automations: definition.automations.map(({ name, trigger, policies }) =>
			jsonObject({
				name,
				description: authoredRuntime.automations[name]?.description,
				trigger: Schema.decodeUnknownSync(Schema.Json)(trigger),
				policies: [...policies],
				...provenance(sourcePathFor(projection, 'automationSourcePaths', name)),
				destination: { kind: 'system', surface: 'automations', selection: name }
			})
		),
		envoys: definition.envoys.map(({ name, transport, audience, groupMessages, delegation }) =>
			jsonObject({
				name,
				transport,
				audience,
				groupMessages,
				delegation,
				...provenance(sourcePathFor(projection, 'envoySourcePaths', name)),
				destination: { kind: 'system', surface: 'envoys', selection: name }
			})
		),
		integrations: integrationEntries(definition, projection),
		remotes: entries(property(projection, 'remoteSourcePaths')).flatMap(([name, path]) => {
			const sourcePath = text(path);
			return sourcePath === undefined ? [] : [jsonObject({ name, ...provenance(sourcePath) })];
		}),
		environment: describeEnvironment(definition.environment).map((entry) =>
			jsonObject({
				...entry,
				...provenance(text(property(projection, 'environmentSourcePath'))),
				destination: { kind: 'system', surface: 'environment' }
			})
		)
	};
};
