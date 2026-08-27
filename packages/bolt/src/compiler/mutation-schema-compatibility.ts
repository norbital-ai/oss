import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Effect } from 'effect';
import { COLLECTION_MUTATION_SCHEMA_COMPATIBILITY_HORIZON_MILLIS } from '@norbital-ai/bolt-protocol';
import type {
	MutationCompatibilityAdapter,
	MutationCompatibilityDefinition,
	RelationDefinition
} from '../authoring/workspace-schema.js';

/** The compiler-owned audit ledger beside the immutable SQL/snapshot migration lineage. */
export const MUTATION_COMPATIBILITY_LEDGER_FILE = 'mutation-compatibility.json';

type MutationAction = 'create' | 'update' | 'delete';
const MUTATION_ACTIONS: ReadonlyArray<MutationAction> = ['create', 'update', 'delete'];

export type MutationSchemaField = Readonly<{
	readonly type: string;
	readonly typeSchema: string | null;
	readonly dimensions: number;
	readonly notNull: boolean;
	readonly default: string | null;
	readonly generated: string | null;
}>;

export type MutationSchemaDescriptor = Readonly<{
	readonly collections: Readonly<
		Record<string, Readonly<{ readonly fields: Readonly<Record<string, MutationSchemaField>> }>>
	>;
	readonly relations: ReadonlyArray<
		Readonly<{
			readonly name: string;
			readonly source: string;
			readonly target: string;
			readonly cardinality: 'one' | 'many';
		}>
	>;
}>;

export type MutationCompatibilityCheckpoint = Readonly<{
	readonly schemaFingerprint: string;
	readonly activatedAtEpochMs: number;
	readonly retiredAtEpochMs?: number;
	readonly schema: MutationSchemaDescriptor;
	/** A direct source-to-current adapter. Expired checkpoints keep it for audit, but are not shipped. */
	readonly adapterToCurrent?: MutationCompatibilityAdapter;
}>;

export type MutationCompatibilityLedger = Readonly<{
	readonly version: 1;
	readonly offlineHorizonMillis: number;
	readonly currentSchemaFingerprint: string;
	readonly checkpoints: ReadonlyArray<MutationCompatibilityCheckpoint>;
}>;

type SnapshotColumn = Readonly<{
	readonly entityType: 'columns';
	readonly table: string;
	readonly name: string;
	readonly type: string;
	readonly typeSchema?: string | null;
	readonly dimensions?: number;
	readonly notNull: boolean;
	readonly default?: string | null;
	readonly generated?: Readonly<{ readonly as: string }> | null;
}>;

type SnapshotLike = Readonly<{ readonly ddl: ReadonlyArray<unknown> }>;

const isSnapshotColumn = (value: unknown): value is SnapshotColumn => {
	if (value === null || typeof value !== 'object') return false;
	const entry = value as Record<string, unknown>;
	return (
		entry['entityType'] === 'columns' &&
		typeof entry['table'] === 'string' &&
		typeof entry['name'] === 'string' &&
		typeof entry['type'] === 'string' &&
		typeof entry['notNull'] === 'boolean'
	);
};

const canonicalDescriptor = (descriptor: MutationSchemaDescriptor): MutationSchemaDescriptor => ({
	collections: Object.fromEntries(
		Object.entries(descriptor.collections)
			.toSorted(([left], [right]) => left.localeCompare(right))
			.map(([collection, definition]) => [
				collection,
				{
					fields: Object.fromEntries(
						Object.entries(definition.fields).toSorted(([left], [right]) =>
							left.localeCompare(right)
						)
					)
				}
			])
	),
	relations: [...descriptor.relations].toSorted((left, right) =>
		[left.source, left.name, left.target, left.cardinality]
			.join('\u0000')
			.localeCompare([right.source, right.name, right.target, right.cardinality].join('\u0000'))
	)
});

/**
 * The mutation-visible logical schema derived from the same Drizzle snapshot that owns migration
 * DDL. The fixed CRUD verbs are included in the fingerprint source below; there is no second
 * authorable action registry for the compatibility compiler to guess from.
 */
export const mutationSchemaDescriptor = (
	snapshot: SnapshotLike,
	relations: ReadonlyArray<RelationDefinition>
): MutationSchemaDescriptor => {
	const collections: Record<string, { fields: Record<string, MutationSchemaField> }> = {};
	for (const entry of snapshot.ddl) {
		if (!isSnapshotColumn(entry)) continue;
		const collection = collections[entry.table] ?? { fields: {} };
		collection.fields[entry.name] = {
			type: entry.type,
			typeSchema: entry.typeSchema ?? null,
			dimensions: entry.dimensions ?? 0,
			notNull: entry.notNull,
			default: entry.default ?? null,
			generated: entry.generated?.as ?? null
		};
		collections[entry.table] = collection;
	}
	return canonicalDescriptor({
		collections,
		relations: relations.map(({ name, source, target, cardinality }) => ({
			name,
			source,
			target,
			cardinality
		}))
	});
};

/** A schema fingerprint changes for every mutation-visible field, relation, or CRUD vocabulary change. */
export const mutationSchemaFingerprint = (schema: MutationSchemaDescriptor): string =>
	`sha256:${createHash('sha256')
		.update(JSON.stringify({ actions: MUTATION_ACTIONS, schema: canonicalDescriptor(schema) }))
		.digest('hex')}`;

const storageCompatible = (left: MutationSchemaField, right: MutationSchemaField): boolean =>
	left.type === right.type &&
	left.typeSchema === right.typeSchema &&
	left.dimensions === right.dimensions;

const createSemanticsCompatible = (left: MutationSchemaField, right: MutationSchemaField): boolean =>
	left.notNull === right.notNull &&
	left.default === right.default &&
	left.generated === right.generated;

type RenameMaps = Readonly<{
	readonly collections: Readonly<Record<string, string>>;
	readonly fields: Readonly<Record<string, Readonly<Record<string, string>>>>;
}>;

/** Only explicit generated DDL can distinguish a rename from a same-shaped remove plus add. */
export const mutationSchemaRenames = (statements: ReadonlyArray<string>): RenameMaps => {
	const collections: Record<string, string> = {};
	const fields: Record<string, Record<string, string>> = {};
	const sql = statements.join('\n');
	for (const match of sql.matchAll(
		/ALTER\s+TABLE\s+(?:(?:"public"\.)?"([^"]+)")\s+RENAME\s+TO\s+"([^"]+)"/gi
	)) {
		const from = match[1];
		const to = match[2];
		if (from !== undefined && to !== undefined) collections[from] = to;
	}
	for (const match of sql.matchAll(
		/ALTER\s+TABLE\s+(?:(?:"public"\.)?"([^"]+)")\s+RENAME\s+COLUMN\s+"([^"]+)"\s+TO\s+"([^"]+)"/gi
	)) {
		const table = match[1];
		const from = match[2];
		const to = match[3];
		if (table === undefined || from === undefined || to === undefined) continue;
		(fields[table] ??= {})[from] = to;
	}
	return { collections, fields };
};

const relationFields = (
	schema: MutationSchemaDescriptor,
	collection: string
): Readonly<Record<string, MutationSchemaField & { readonly target: string; readonly cardinality: 'one' | 'many' }>> =>
	Object.fromEntries(
		schema.relations
			.filter(({ source }) => source === collection)
			.map(({ name, target, cardinality }) => [
				name,
				{
					type: 'relationship',
					typeSchema: null,
					dimensions: cardinality === 'many' ? 1 : 0,
					notNull: false,
					default: null,
					generated: null,
					target,
					cardinality
				}
			])
	);

type MutationRelationField = MutationSchemaField & {
	readonly target: string;
	readonly cardinality: 'one' | 'many';
};

/** Narrows a plain stored field from the synthetic relationship fields joined beside it. */
const isMutationRelationField = (
	field: MutationSchemaField | MutationRelationField
): field is MutationRelationField =>
	'target' in field &&
	typeof field.target === 'string' &&
	'cardinality' in field &&
	(field.cardinality === 'one' || field.cardinality === 'many');

const nonEmptyRecord = <T>(value: Record<string, T>): Readonly<Record<string, T>> | undefined =>
	Object.keys(value).length === 0 ? undefined : value;

/** Classifies one adjacent compiler-owned migration into the smallest safe forward adapter. */
export const classifyMutationSchemaTransition = (input: Readonly<{
	readonly fromSchemaFingerprint: string;
	readonly from: MutationSchemaDescriptor;
	readonly to: MutationSchemaDescriptor;
	readonly statements: ReadonlyArray<string>;
}>): MutationCompatibilityAdapter => {
	const declaredRenames = mutationSchemaRenames(input.statements);
	const collectionRenames: Record<string, string> = {};
	const fieldRenames: Record<string, Readonly<Record<string, string>>> = {};
	const incompatibleFields: Record<string, ReadonlyArray<string>> = {};
	const incompatibleActions: Record<string, ReadonlyArray<MutationAction>> = {};
	for (const [oldCollection, oldDefinition] of Object.entries(input.from.collections)) {
		const currentCollection =
			declaredRenames.collections[oldCollection] ??
			(input.to.collections[oldCollection] === undefined ? undefined : oldCollection);
		const currentDefinition =
			currentCollection === undefined ? undefined : input.to.collections[currentCollection];
		if (currentCollection === undefined || currentDefinition === undefined) {
			incompatibleFields[oldCollection] = [
				...Object.keys(oldDefinition.fields),
				...Object.keys(relationFields(input.from, oldCollection))
			].toSorted();
			incompatibleActions[oldCollection] = MUTATION_ACTIONS;
			continue;
		}
		if (currentCollection !== oldCollection) collectionRenames[oldCollection] = currentCollection;
		const renames: Record<string, string> = {};
		const incompatible = new Set<string>();
		let incompatibleCreate = false;
		const oldFields = {
			...oldDefinition.fields,
			...relationFields(input.from, oldCollection)
		};
		const currentFields = {
			...currentDefinition.fields,
			...relationFields(input.to, currentCollection)
		};
		const declaredFieldRenames = {
			...(declaredRenames.fields[oldCollection] ?? {}),
			...(declaredRenames.fields[currentCollection] ?? {})
		};
		for (const [oldField, oldShape] of Object.entries(oldFields)) {
			const currentField =
				declaredFieldRenames[oldField] ??
				(currentFields[oldField] === undefined ? undefined : oldField);
			const currentShape = currentField === undefined ? undefined : currentFields[currentField];
			if (currentField === undefined || currentShape === undefined) {
				incompatible.add(oldField);
				continue;
			}
			// Record identity is protocol identity. A migration may rename an ordinary column, but no
			// compatibility adapter is permitted to reinterpret, synthesize, or redirect `id`.
			if (oldField === 'id' && currentField !== 'id') {
				incompatible.add(oldField);
				continue;
			}
			const oldRelation = isMutationRelationField(oldShape) ? oldShape : undefined;
			const currentRelation = isMutationRelationField(currentShape) ? currentShape : undefined;
			const relationCompatible =
				oldRelation === undefined && currentRelation === undefined
					? true
					: oldRelation !== undefined &&
						currentRelation !== undefined &&
						oldRelation.cardinality === currentRelation.cardinality &&
						(declaredRenames.collections[oldRelation.target] ?? oldRelation.target) ===
							currentRelation.target;
			if (!relationCompatible || !storageCompatible(oldShape, currentShape)) {
				incompatible.add(oldField);
				continue;
			}
			if (!createSemanticsCompatible(oldShape, currentShape)) incompatibleCreate = true;
			if (currentField !== oldField) renames[oldField] = currentField;
		}
		for (const [currentField, currentShape] of Object.entries(currentDefinition.fields)) {
			const wasPresent = Object.entries(oldDefinition.fields).some(([oldField]) =>
				(declaredFieldRenames[oldField] ?? oldField) === currentField
			);
			if (!wasPresent && currentShape.notNull && currentShape.default === null) incompatibleCreate = true;
		}
		if (Object.keys(renames).length > 0) fieldRenames[oldCollection] = renames;
		if (incompatible.size > 0) incompatibleFields[oldCollection] = [...incompatible].toSorted();
		if (incompatibleCreate) incompatibleActions[oldCollection] = ['create'];
	}
	return {
		fromSchemaFingerprint: input.fromSchemaFingerprint,
		...(nonEmptyRecord(collectionRenames) === undefined ? {} : { collectionRenames }),
		...(nonEmptyRecord(fieldRenames) === undefined ? {} : { fieldRenames }),
		...(nonEmptyRecord(incompatibleFields) === undefined ? {} : { incompatibleFields }),
		...(nonEmptyRecord(incompatibleActions) === undefined ? {} : { incompatibleActions })
	};
};

const composeNames = (
	first: Readonly<Record<string, string>> | undefined,
	second: Readonly<Record<string, string>> | undefined,
	name: string
): string => second?.[first?.[name] ?? name] ?? first?.[name] ?? name;

/** Composes two adjacent adapters into the direct source-to-current form dispatch consumes. */
export const composeMutationCompatibilityAdapters = (
	first: MutationCompatibilityAdapter,
	second: MutationCompatibilityAdapter
): MutationCompatibilityAdapter => {
	const sourceCollections = new Set([
		...Object.keys(first.collectionRenames ?? {}),
		...Object.keys(first.fieldRenames ?? {}),
		...Object.keys(first.incompatibleFields ?? {}),
		...Object.keys(first.incompatibleActions ?? {})
	]);
	const collectionRenames: Record<string, string> = {};
	const fieldRenames: Record<string, Readonly<Record<string, string>>> = {};
	const incompatibleFields: Record<string, ReadonlyArray<string>> = {};
	const incompatibleActions: Record<string, ReadonlyArray<MutationAction>> = {};
	for (const sourceCollection of sourceCollections) {
		const intermediateCollection = first.collectionRenames?.[sourceCollection] ?? sourceCollection;
		const currentCollection =
			second.collectionRenames?.[intermediateCollection] ?? intermediateCollection;
		if (currentCollection !== sourceCollection) collectionRenames[sourceCollection] = currentCollection;
		const firstRenames = first.fieldRenames?.[sourceCollection] ?? {};
		const secondRenames = second.fieldRenames?.[intermediateCollection] ?? {};
		const names = new Set([
			...Object.keys(firstRenames),
			...(first.incompatibleFields?.[sourceCollection] ?? [])
		]);
		for (const [intermediateField] of Object.entries(secondRenames)) {
			const source =
				Object.entries(firstRenames).find(([, target]) => target === intermediateField)?.[0] ??
				intermediateField;
			names.add(source);
		}
		for (const intermediateField of second.incompatibleFields?.[intermediateCollection] ?? []) {
			const source =
				Object.entries(firstRenames).find(([, target]) => target === intermediateField)?.[0] ??
				intermediateField;
			names.add(source);
		}
		const renames: Record<string, string> = {};
		const incompatible = new Set(first.incompatibleFields?.[sourceCollection] ?? []);
		for (const sourceField of names) {
			const intermediateField = firstRenames[sourceField] ?? sourceField;
			if ((second.incompatibleFields?.[intermediateCollection] ?? []).includes(intermediateField)) {
				incompatible.add(sourceField);
				continue;
			}
			const currentField = secondRenames[intermediateField] ?? intermediateField;
			if (currentField !== sourceField) renames[sourceField] = currentField;
		}
		if (Object.keys(renames).length > 0) fieldRenames[sourceCollection] = renames;
		if (incompatible.size > 0) incompatibleFields[sourceCollection] = [...incompatible].toSorted();
		const actions = new Set<MutationAction>(first.incompatibleActions?.[sourceCollection] ?? []);
		for (const action of second.incompatibleActions?.[intermediateCollection] ?? []) actions.add(action);
		if (actions.size > 0) incompatibleActions[sourceCollection] = [...actions].toSorted();
	}
	// Collections unchanged in the first transition may acquire their first incompatibility in the
	// second. They are still source collections and must join the direct adapter.
	for (const intermediateCollection of new Set([
		...Object.keys(second.collectionRenames ?? {}),
		...Object.keys(second.fieldRenames ?? {}),
		...Object.keys(second.incompatibleFields ?? {}),
		...Object.keys(second.incompatibleActions ?? {})
	])) {
		const sourceCollection =
			Object.entries(first.collectionRenames ?? {}).find(([, target]) => target === intermediateCollection)?.[0] ??
			intermediateCollection;
		if (sourceCollections.has(sourceCollection)) continue;
		const currentCollection = composeNames(
			first.collectionRenames,
			second.collectionRenames,
			sourceCollection
		);
		if (currentCollection !== sourceCollection) collectionRenames[sourceCollection] = currentCollection;
		const renames = second.fieldRenames?.[intermediateCollection];
		if (renames !== undefined) fieldRenames[sourceCollection] = renames;
		const fields = second.incompatibleFields?.[intermediateCollection];
		if (fields !== undefined) incompatibleFields[sourceCollection] = fields;
		const actions = second.incompatibleActions?.[intermediateCollection];
		if (actions !== undefined) incompatibleActions[sourceCollection] = actions;
	}
	return {
		fromSchemaFingerprint: first.fromSchemaFingerprint,
		...(nonEmptyRecord(collectionRenames) === undefined ? {} : { collectionRenames }),
		...(nonEmptyRecord(fieldRenames) === undefined ? {} : { fieldRenames }),
		...(nonEmptyRecord(incompatibleFields) === undefined ? {} : { incompatibleFields }),
		...(nonEmptyRecord(incompatibleActions) === undefined ? {} : { incompatibleActions })
	};
};

/** Advances the persisted release lineage without deleting expired history. */
export const advanceMutationCompatibilityLedger = (input: Readonly<{
	readonly previous: MutationCompatibilityLedger | undefined;
	readonly schema: MutationSchemaDescriptor;
	readonly statements: ReadonlyArray<string>;
	readonly atEpochMs: number;
	readonly offlineHorizonMillis?: number;
}>): MutationCompatibilityLedger => {
	const fingerprint = mutationSchemaFingerprint(input.schema);
	const horizon =
		input.previous?.offlineHorizonMillis ??
		input.offlineHorizonMillis ??
		COLLECTION_MUTATION_SCHEMA_COMPATIBILITY_HORIZON_MILLIS;
	if (input.previous === undefined)
		return {
			version: 1,
			offlineHorizonMillis: horizon,
			currentSchemaFingerprint: fingerprint,
			checkpoints: [
				{
					schemaFingerprint: fingerprint,
					activatedAtEpochMs: input.atEpochMs,
					schema: canonicalDescriptor(input.schema)
				}
			]
		};
	if (input.previous.currentSchemaFingerprint === fingerprint) return input.previous;
	const current = input.previous.checkpoints.find(
		(checkpoint) => checkpoint.schemaFingerprint === input.previous?.currentSchemaFingerprint
	);
	if (current === undefined)
		throw new Error(
			`Mutation compatibility ledger has no current checkpoint ${input.previous.currentSchemaFingerprint}.`
		);
	const adjacent = classifyMutationSchemaTransition({
		fromSchemaFingerprint: current.schemaFingerprint,
		from: current.schema,
		to: input.schema,
		statements: input.statements
	});
	const checkpoints = input.previous.checkpoints.map((checkpoint) => {
		if (
			checkpoint.retiredAtEpochMs !== undefined &&
			checkpoint.retiredAtEpochMs + horizon < input.atEpochMs
		)
			return checkpoint;
		const adapter =
			checkpoint.schemaFingerprint === current.schemaFingerprint
				? adjacent
				: checkpoint.adapterToCurrent === undefined
					? undefined
					: composeMutationCompatibilityAdapters(checkpoint.adapterToCurrent, adjacent);
		return {
			...checkpoint,
			...(checkpoint.schemaFingerprint === current.schemaFingerprint
				? { retiredAtEpochMs: input.atEpochMs }
				: {}),
			...(adapter === undefined ? {} : { adapterToCurrent: adapter })
		};
	});
	const reintroduced = checkpoints.find((checkpoint) => checkpoint.schemaFingerprint === fingerprint);
	return {
		version: 1,
		offlineHorizonMillis: horizon,
		currentSchemaFingerprint: fingerprint,
		checkpoints:
			reintroduced === undefined
				? [
						...checkpoints,
						{
							schemaFingerprint: fingerprint,
							activatedAtEpochMs: input.atEpochMs,
							schema: canonicalDescriptor(input.schema)
						}
					]
				: checkpoints.map((checkpoint) =>
						checkpoint.schemaFingerprint === fingerprint
							? {
									schemaFingerprint: checkpoint.schemaFingerprint,
									activatedAtEpochMs: checkpoint.activatedAtEpochMs,
									schema: checkpoint.schema
								}
							: checkpoint
					)
	};
};

/** Projects only still-promised adapters into the artifact; audit checkpoints remain on disk. */
export const mutationCompatibilityArtifact = (
	ledger: MutationCompatibilityLedger,
	atEpochMs: number
): MutationCompatibilityDefinition => ({
	offlineHorizonMillis: ledger.offlineHorizonMillis,
	currentSchemaFingerprint: ledger.currentSchemaFingerprint,
	adapters: ledger.checkpoints.flatMap((checkpoint) =>
		checkpoint.schemaFingerprint === ledger.currentSchemaFingerprint ||
		checkpoint.adapterToCurrent === undefined ||
		(checkpoint.retiredAtEpochMs !== undefined &&
			checkpoint.retiredAtEpochMs + ledger.offlineHorizonMillis < atEpochMs)
			? []
			: [checkpoint.adapterToCurrent]
	)
});

const ledgerPath = (workspaceRoot: string): string =>
	join(workspaceRoot, '.norbital', 'migrations', MUTATION_COMPATIBILITY_LEDGER_FILE);

const parseLedger = (source: string, path: string): MutationCompatibilityLedger => {
	const parsed: unknown = JSON.parse(source);
	if (parsed === null || typeof parsed !== 'object')
		throw new Error(`Mutation compatibility ledger ${path} is not an object.`);
	const ledger = parsed as Partial<MutationCompatibilityLedger>;
	if (
		ledger.version !== 1 ||
		typeof ledger.offlineHorizonMillis !== 'number' ||
		typeof ledger.currentSchemaFingerprint !== 'string' ||
		!Array.isArray(ledger.checkpoints)
	)
		throw new Error(`Mutation compatibility ledger ${path} has an unsupported shape.`);
	return ledger as MutationCompatibilityLedger;
};

export const readMutationCompatibilityLedger = (workspaceRoot: string) =>
	Effect.tryPromise({
		try: () => readFile(ledgerPath(workspaceRoot), 'utf8'),
		catch: (cause) => cause
	}).pipe(
		Effect.map((source) => parseLedger(source, ledgerPath(workspaceRoot))),
		Effect.catch((failure: unknown) =>
			(failure as NodeJS.ErrnoException).code === 'ENOENT' ||
			(failure as { readonly cause?: NodeJS.ErrnoException }).cause?.code === 'ENOENT'
				? Effect.succeed<MutationCompatibilityLedger | undefined>(undefined)
				: Effect.fail(failure)
		)
	);

export const writeMutationCompatibilityLedger = (
	workspaceRoot: string,
	ledger: MutationCompatibilityLedger
) =>
	Effect.gen(function* () {
		const path = ledgerPath(workspaceRoot);
		const pending = `${path}.next`;
		yield* Effect.tryPromise(() =>
			writeFile(pending, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')
		);
		// The committed ledger is replaced only after the complete next document has been written in its
		// sibling file, so an interrupted compiler cannot silently truncate compatibility history.
		yield* Effect.tryPromise(() => rename(pending, path));
	});
