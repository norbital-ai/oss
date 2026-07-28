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
		.map(({ name, isArray }) => {
			const value = record[name];
			if (value == null || isArray || typeof value === 'object') return null;
			return String(value);
		})
		.filter(Boolean) as string[];
	const pk = record[SYSTEM_COLUMN_NAMES.PKEY];
	return {
		text: texts.length > 0 ? texts.join(', ') : `ID: ${pk ?? ''}`,
		isFallback: texts.length === 0
	};
}

export function resolveRecordLabel(
	recordLabelExpression: string | null,
	record: object
): string | null {
	if (!recordLabelExpression) return null;
	try {
		const result = evaluateCelExpression(recordLabelExpression, { scope: { record } });
		return typeof result === 'string' && result.trim().length > 0 ? result : null;
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
