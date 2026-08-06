import { evaluateCelExpression } from '@norbital-ai/std/cel';
import { humanize } from '@norbital-ai/std/string';
import type { NumericRendererVariant } from '../collection/types.js';
import { isSystemColumnName, SYSTEM_COLUMN_NAMES } from '../system/column_names.js';
import type {
	ManifestApp,
	ManifestCollectionEntry,
	ManifestRelationship,
	NorbitalManifest
} from './types.js';

export interface CollectionColumn {
	readonly dataType: string;
	readonly notNull: boolean;
	readonly array?: boolean;
	readonly values?: readonly string[];
	readonly options?: Readonly<Record<string, unknown>>;
	readonly currencies?: readonly string[];
	readonly mimeTypes?: readonly string[];
	readonly variant?: NumericRendererVariant;
}

export type CollectionColumnMap = Readonly<Record<string, CollectionColumn>>;

type TCollectionMetadata = ManifestCollectionEntry;
type TRelationship = ManifestRelationship;
type TApp = ManifestApp;
type TUiModuleRef = {
	readonly id: string;
	readonly config?: ManifestApp['config'];
};

class ManifestIndex {
	private readonly _collectionByName: Map<string, TCollectionMetadata>;
	private readonly _fieldByName: Map<string, CollectionColumn>;

	private constructor(
		collectionByName: Map<string, TCollectionMetadata>,
		fieldByName: Map<string, CollectionColumn>
	) {
		this._collectionByName = collectionByName;
		this._fieldByName = fieldByName;
	}

	static from(
		collections: NorbitalManifest['collections'],
		columns: Readonly<Record<string, CollectionColumnMap>>
	): ManifestIndex {
		const collectionByName = new Map<string, TCollectionMetadata>();
		const fieldByName = new Map<string, CollectionColumn>();

		for (const collection of Object.values(collections)) {
			collectionByName.set(collection.collection_name, collection);
			const collectionColumns = columns[collection.collection_name] ?? {};
			for (const [fieldName, field] of Object.entries(collectionColumns)) {
				if (isSystemColumnName(fieldName)) continue;
				fieldByName.set(`${collection.collection_name}.${fieldName}`, field);
			}
		}

		return new ManifestIndex(collectionByName, fieldByName);
	}

	findCollection(name: string): TCollectionMetadata | null {
		return this._collectionByName.get(name) ?? null;
	}

	findField(qualified: string): CollectionColumn | undefined {
		return this._fieldByName.get(qualified);
	}

	tenantCollectionNameSample(limit: number): string[] {
		return [...this._collectionByName.keys()].slice(0, limit);
	}
}

/** Separator the schema builder compiles between the fields of a multi-field record label. */
const LABEL_TERM_SEPARATOR = ' · ';
/** The compiled join, as `modelTableMeta` emits it: `<term> + ' · ' + <term>`. */
const LABEL_TERM_JOIN = /\s\+\s'\s·\s'\s\+\s/;

/**
 * An opaque identifier, which must never be shown to a person as the name of a record.
 *
 * Matching on the *value* rather than the column name is the honest test: a column called
 * `employee_id` may well hold a payroll number worth reading, while `employment_id` holds a uuid
 * that means nothing to anyone. What disqualifies a value is being an identifier, not being called
 * one.
 */
const UUID_SHAPED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Render one label term as text, or null when it has nothing to contribute.
 *
 * CEL cannot do this itself. Its `+` has no overload but string+string, and `string()` has no
 * overload for timestamps or null — so a label naming a `date()` column, a number, a boolean or an
 * empty field throws instead of concatenating, however the expression is written. Coercion
 * therefore belongs here, where the values are ordinary JavaScript and a missing one can simply be
 * left out.
 */
function labelTermText(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) return null;
		const iso = value.toISOString();
		// Locale-independent on purpose: these labels are also built server-side, for approval
		// requests and audit subjects, where there is no viewer whose locale could be consulted.
		return iso.endsWith('T00:00:00.000Z')
			? iso.slice(0, 10)
			: `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
	}
	// A relation payload, an array or a JSON blob is not a title. A `custom()` JSONB column named as
	// a record label can never produce one, and no coercion changes that — so it contributes
	// nothing and the caller degrades to the placeholder, rather than printing `{"status":"OK"}`
	// or, worse, falling through to a scan that puts a foreign key on screen.
	if (typeof value === 'object') return null;
	const text = String(value).trim();
	if (!text || UUID_SHAPED.test(text)) return null;
	// The same blob, after a round trip through JSONB, arrives as its own serialization.
	if (JSON_SHAPED.test(text) && parsesAsJsonContainer(text)) return null;
	return text;
}

/** Cheap gate before the parse, so ordinary prose never pays for it. */
const JSON_SHAPED = /^[{[][\s\S]*[}\]]$/;

function parsesAsJsonContainer(text: string): boolean {
	try {
		return typeof JSON.parse(text) === 'object' && JSON.parse(text) !== null;
	} catch {
		return false;
	}
}

export function resolveRecordDisplayLabel(
	metadata: TCollectionMetadata | null,
	record: Record<string, unknown>,
	columns: CollectionColumnMap = {}
): { text: string; isFallback: boolean } {
	const recordLabelExpr = metadata?.record_label ?? null;

	if (recordLabelExpr) {
		const label = resolveRecordLabel(recordLabelExpr, record);
		if (label) return { text: label, isFallback: false };
	}

	const cols = metadata
		? Object.keys(columns)
				.filter((name) => !isSystemColumnName(name))
				.map((name) => ({ name, isArray: false }))
		: Object.keys(record)
				.filter((key) => !key.startsWith('norbital_'))
				.map((name) => ({ name, isArray: false }));

	const texts = cols
		.map(({ name, isArray }) => (isArray ? null : labelTermText(record[name])))
		.filter((text): text is string => text !== null);
	if (texts.length > 0) return { text: texts.join(', '), isFallback: false };

	// Nothing on this record can name it. Saying what kind of thing it is beats printing its
	// primary key: the uuid identifies the row to the database and to nobody else, and putting it
	// in a title is how `employment_id` ended up reading as a record's name.
	const kind = metadata?.collection_name ? humanize(metadata.collection_name) : '';
	return { text: kind ? `Untitled ${kind.toLowerCase()}` : 'Untitled record', isFallback: true };
}

export function resolveRecordLabel(
	recordLabelExpression: string | null,
	record: object
): string | null {
	if (!recordLabelExpression) return null;
	// One set of rules, whichever path produced the text: an expression that evaluated cleanly to a
	// uuid or to a serialized JSON blob is no more a title than the same value reached term by term.
	const whole = labelTermText(evaluateLabelExpression(recordLabelExpression, record));
	if (whole) return whole;

	// The whole expression could not produce a string. For the compiled multi-field form that is
	// the norm rather than the exception — one non-string or null term is enough to throw the
	// entire concatenation — so evaluate the terms separately and join whatever survives. A single
	// empty field now costs its own term instead of the whole title, and with it the fallback that
	// used to put a uuid on screen. A single-field label splits to one term, which is the same
	// evaluation as `whole`, so this also covers `recordLabel: 'work_date'` — a value that was never
	// a string to begin with.
	const texts = recordLabelExpression
		.split(LABEL_TERM_JOIN)
		.map((term) => labelTermText(evaluateLabelExpression(term, record)))
		.filter((text): text is string => text !== null);
	return texts.length > 0 ? texts.join(LABEL_TERM_SEPARATOR) : null;
}

function evaluateLabelExpression(expression: string, record: object): unknown {
	try {
		return evaluateCelExpression(expression, { scope: { record } });
	} catch {
		return null;
	}
}

export type ManifestContextInput =
	| NorbitalManifest
	| {
			readonly manifest: NorbitalManifest;
			readonly nodeId?: string;
			readonly columns?: Readonly<Record<string, CollectionColumnMap>>;
	  };

/** Project portable manifest fields into the column map used by agent/UI schema tools. */
export function collectionColumnsFromManifestFields(
	collections: NorbitalManifest['collections']
): Record<string, CollectionColumnMap> {
	return Object.fromEntries(
		Object.values(collections).map((collection) => [
			collection.collection_name,
			Object.fromEntries(
				(collection.fields ?? [])
					.filter((field) => !isSystemColumnName(field.name))
					.map((field) => [
						field.name,
						{
							dataType: field.kind,
							notNull: !field.nullable,
							...(field.array ? { array: true } : {}),
							...(field.values ? { values: field.values } : {}),
							...(field.options ? { options: field.options } : {}),
							...(field.currencies ? { currencies: field.currencies } : {}),
							...(field.mimeTypes ? { mimeTypes: field.mimeTypes } : {}),
							...(field.variant ? { variant: field.variant } : {})
						} satisfies CollectionColumn
					])
			)
		])
	);
}

export class ManifestContext {
	#manifest: NorbitalManifest;
	readonly #nodeId: string;
	readonly #columns: Readonly<Record<string, CollectionColumnMap>>;
	#index: ManifestIndex;

	constructor(input: ManifestContextInput) {
		const wrapped = 'manifest' in input ? input : { manifest: input };
		this.#manifest = wrapped.manifest;
		this.#nodeId = wrapped.nodeId ?? '';
		this.#columns =
			wrapped.columns ?? collectionColumnsFromManifestFields(this.#manifest.collections);
		this.#index = ManifestIndex.from(this.#manifest.collections, this.#columns);
	}

	private _rebuildIndex(): void {
		this.#index = ManifestIndex.from(this.#manifest.collections, this.#columns);
	}

	replaceManifest(manifest: NorbitalManifest): void {
		this.#manifest = manifest;
		this._rebuildIndex();
	}

	get manifest(): NorbitalManifest {
		return this.#manifest;
	}

	get nodeId(): string {
		return this.#nodeId;
	}

	columnsFor(collectionName: string): CollectionColumnMap {
		return this.#columns[collectionName] ?? {};
	}

	get recordIdKey(): string {
		return SYSTEM_COLUMN_NAMES.PKEY;
	}

	getCollections(): TCollectionMetadata[] {
		return Object.values(this.#manifest.collections);
	}

	getCollectionsRecord(): Record<string, TCollectionMetadata> {
		return this.#manifest.collections;
	}

	getApps(): TApp[] {
		return Object.values(this.#manifest.apps ?? {});
	}

	getAppsRecord(): Record<string, TApp> {
		return this.#manifest.apps ?? {};
	}

	getRelationships(): TRelationship[] {
		return Object.values(this.#manifest.relationships ?? {});
	}

	private _getRelationshipsRecord(): Record<string, TRelationship> {
		return this.#manifest.relationships ?? {};
	}

	getRelationshipsForCollection(
		collectionName: string
	): Array<{ name: string; rel: TRelationship }> {
		const out: Array<{ name: string; rel: TRelationship }> = [];
		for (const [name, rel] of Object.entries(this._getRelationshipsRecord())) {
			if (rel.from === collectionName || rel.to === collectionName) {
				out.push({ name, rel });
			}
		}
		return out;
	}

	getRelationship(relName: string): TRelationship {
		const rel = this.findRelationship(relName);
		if (!rel) {
			throw new Error(`Relationship '${relName}' not found in manifest`);
		}
		return rel;
	}

	findRelationship(relName: string): TRelationship | null {
		return this._getRelationshipsRecord()[relName] ?? null;
	}

	static getRelationshipDirection(
		rel: TRelationship,
		currentCollection: string
	): { isForward: boolean; otherCollection: string } {
		if (rel.from !== currentCollection && rel.to !== currentCollection) {
			throw new Error(
				`Relationship ('${rel.from}' -> '${rel.to}') does not involve collection '${currentCollection}'`
			);
		}
		const isForward = rel.from === currentCollection;
		const otherCollection = isForward ? rel.to : rel.from;
		return { isForward, otherCollection };
	}

	findCollection(name: string): TCollectionMetadata | null {
		return this._index.findCollection(name);
	}

	findApp(appName: string): TApp | null {
		return this.#manifest.apps?.[appName] ?? null;
	}

	findAppUiModule(appName: string): {
		app: TApp;
		uiModule: TUiModuleRef;
		path: string[];
	} | null {
		const app = this.findApp(appName);
		if (!app) return null;

		const route = `app/${app.name}`;

		return {
			app,
			uiModule: { id: route, config: app.config },
			path: ['apps', app.name, 'route']
		};
	}

	getCollectionTitle(collectionName: string): string {
		const collection = this.findCollection(collectionName);
		return collection ? humanize(collection.collection_name) : collectionName;
	}

	getRecordDisplayLabel(
		record: Record<string, unknown>,
		collectionNameOrId: string
	): { text: string; isFallback: boolean } {
		const metadata = this._index.findCollection(collectionNameOrId);
		return resolveRecordDisplayLabel(metadata, record, this.columnsFor(collectionNameOrId));
	}

	getEnvPublic(): Record<string, string> {
		return (this.#manifest.env?.public ?? {}) as Record<string, string>;
	}

	stripSecretsForClient(): NorbitalManifest {
		const { secrets: _, integrations: __, ...manifest } = this.#manifest;
		return {
			...manifest
		};
	}

	collectionExists(collectionName: string): boolean {
		return this.findCollection(collectionName) !== null;
	}

	listCollectionNames(): string[] {
		return Object.keys(this.#manifest.collections);
	}

	getCollection(collectionName: string): TCollectionMetadata {
		const collection = this._index.findCollection(collectionName);
		if (!collection) {
			const availableNames = this._index.tenantCollectionNameSample(5);
			throw new Error(
				`Collection '${collectionName}' not found in manifest. ` +
					`Available (first 5): Names=[${availableNames.join(', ')}]`
			);
		}
		return collection;
	}

	/** @internal */
	private get _index(): ManifestIndex {
		return this.#index;
	}
}
