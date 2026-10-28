// What the kit's renderers and editors learn from the shell, once per page (hook:ui-shell sets `provideKinds` beside
// `provideBolt`): the models' exposure, the workspace's custom fields, and the optional facilities the host has.
// Every optional member absent is a working page: files show names, points search with the keyless geocoder.
import { Effect, Result, Schema } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientResponse, type HttpClientError } from 'effect/http';
import { getContext, setContext, type Component } from 'svelte';
import type { ActFailure, ReadError } from '../client/contract.js';
import type { FileRef, Fields, Json, Kind, Point, Value } from './kind.js';
import type { FileUrlOptions, Where } from '@norbital-ai/std/kind';

export type ChildInput = {
	model: string;
	parent: string;
	owned?: true;
	create?: { columns: readonly string[]; filled?: readonly string[]; proposalOnly?: true };
	update?: { columns: readonly string[] };
	delete?: true;
	link?: true;
	unlink?: true;
};

/** One model as a form, a picker and a view toolbar need it (generated from its `+model.ts` and the caller's grants). */
export type ModelExposure = {
	/** The model's `label` fields: a record's title and the picker's search fallback. */
	label: readonly string[];
	/** Search fields when the model declares `search.text`; else the picker searches `label`'s text fields. */
	search?: readonly string[];
	/** The model declares `search.semantic` (text or file fields on an embedding model): the toolbar offers `/semantic`. */
	semantic?: true;
	/** The model's own search indexes (`search.indexes`), by their typed `input`: the toolbar offers each as `/<index>`. */
	indexes?: { readonly [index: string]: { input: Fields; description: string } };
	/** Model fields the caller may read (hidden ones included; `hidden` renders nothing). */
	fields: Fields;
	/** One-relations as FK columns: `holder` → `employees`. A polymorphic ref lists every target. */
	relations?: {
		readonly [fk: string]: {
			targets: readonly string[];
			optional?: true;
			label?: string;
			inverse?: string;
			/** The relationship's static `where`: a picker offers only the records a write would accept. */
			where?: Where;
		};
	};
	/** The root's declared one-level read layers (`'<model>.<rel>'`'s `rel`): the relations a list read may nest. */
	layers?: readonly string[];
	/** Many-relations (inverses) the model exposes; each child is the model whose relation names it as `inverse`. */
	many?: readonly string[];
	/** Read-side inverse identities; each child is read independently through its own policy. */
	children?: Readonly<Record<string, Pick<ChildInput, 'model' | 'parent' | 'owned'>>>;
	/** Fields masked to this caller (rule 14): shown locked, never offered to filter or sort. */
	masked?: readonly string[];
	create?: {
		columns: readonly string[];
		filled?: readonly string[];
		proposalOnly?: true;
		with?: Readonly<Record<string, ChildInput>>;
	};
	update?: { columns: readonly string[]; with?: Readonly<Record<string, ChildInput>> };
	/** Host-declared field restrictions, in addition to ordinary write grants: a read-only sync's fields, an owned parent. */
	readonlyFields?: { readonly [field: string]: 'syncOwned' | 'ownedParent' };
	/** The model's own-field lock: a matching record is read-only and its record page offers a lock instead of Edit. */
	locked?: Where;
	/** The view toolbar's info text: the model's declared description, else its model's. */
	description?: string;
	/** The caller holds a delete arm. */
	delete?: true;
	/** The model's syncs the caller may run from the toolbar (`<c>.sync.<name>`). */
	syncs?: { readonly [sync: string]: SyncExposure };
};
/** A declared automation the caller may start, with the fields its native form renders. */
export type AutomationExposure = { input: Fields; description?: string };
/** A file parser: a built-in (`xlsx`, `csv`, `tsv`, `json`, `ics`) or a custom one by its media type and extensions. */
export type ParserExposure = string | { type: string; extensions: readonly string[] };
/**
 * A model's sync as the toolbar offers it. A file sync: Import… and Download template when the caller may write the
 * model (`import`), its file picker accepting exactly `parser` (default `xlsx`, `csv`); Export in each of `export`'s
 * formats (a records format, `xlsx`/`csv`/…, or the workspace's convert targets when its `write` returns a document).
 * `context` names the sync's required context fields: the toolbar offers the sync only when its view's `context`
 * supplies them. A remote sync with a `read` the caller may start: "Sync now" pulls from `with`, its integration.
 */
export type SyncExposure =
	| {
			kind: 'file';
			parser?: readonly ParserExposure[];
			import?: true;
			export?: readonly string[];
			context?: readonly string[];
	  }
	| { kind: 'remote'; with: string };
/** What a custom field's renderer receives, a tenant's `src/data/custom_field/<f>/+renderer.svelte` and a built-in's
 * (`money`, `file`, `point`, `phone`) alike (spec §6). `row` is the record's other field values (the form's draft in
 * edit mode), absent when a page embeds the renderer; `kind` is the field's literal (a custom reference's `shape`);
 * `dense` asks for one compact line (a table cell, a card); `address` is a `point` field's address sibling. */
type ViewCommon<V> = {
	name: string;
	value: V | null;
	row?: { readonly [f: string]: Value };
	kind?: Kind;
	id?: string;
	address?: { value: string | null; onChange?(next: string | null): void };
};
/** What a kind's renderer receives (a built-in custom field's, structurally bolt's `CustomFieldView`): its value and, in
 * `edit` mode, `onChange`, `disabled` and the field's error. */
export type KindView<V = Value> =
	| (ViewCommon<V> & { mode: 'show'; dense?: true })
	| (ViewCommon<V> & {
			mode: 'edit';
			disabled: boolean;
			error?: string;
			onChange(next: V | null): void;
	  });
/** A custom field as the ui renders it: its shape, label and optional renderer component; built-ins and tenant fields alike. */
export type CustomFieldEntry = {
	shape: Kind;
	label?: string;
	renderer?: Component<{ view: KindView }>;
};
/** The host's address search (and reverse lookup) a `PointInput` uses when present. */
export type Geocoder = {
	/** `region`: the workspace's country (ISO 3166 alpha-2, from its locale); its places rank first. */
	search(
		query: string,
		options?: { region?: string }
	): Effect.Effect<readonly { point: Point; address: string }[], Error>;
	reverse?(point: Point): Effect.Effect<string | null, Error>;
};
/**
 * What the kind editors take from the host: the catalog, custom fields, uploads and file URLs, the geocoder and basemap, the picker's read, locale, zone and default currency.
 */
export type KindsHost = {
	catalog?: { readonly [model: string]: ModelExposure } | undefined;
	automations?: { readonly [automation: string]: AutomationExposure } | undefined;
	customFields?: { readonly [name: string]: CustomFieldEntry } | undefined;
	/** `bolt.upload`; without it a file field is read-only. */
	upload?(
		file: File,
		field: string
	): Effect.Effect<
		FileRef,
		Extract<ActFailure, { _tag: 'ActRefused' }> | Extract<ReadError, { _tag: 'TransportFailed' }>
	>;
	fileUrl?(ref: FileRef, options?: FileUrlOptions): string;
	/** The host's geocoder (P19); without one, address search uses the keyless `photonGeocoder`. */
	geocoder?: Geocoder;
	/** A keyless tile template; the host may override the OpenStreetMap default. */
	basemap?: { url: string; attribution: string };
	/** The read a picker pages through: `bolt.query` of one read request, a page per root. Without it an `id` is typed. */
	query?(request: { readonly [path: string]: Json }): Effect.Effect<
		{
			readonly [root: string]: {
				rows: readonly ({ readonly id: string } & { readonly [f: string]: Value })[];
				next: string | null;
			};
		},
		ReadError
	>;
	locale?: string | undefined;
	zone?: string | undefined;
	/** The workspace default currency for a money field without one (X-8). */
	currency?: string | undefined;
};

const KEY = Symbol.for('norbital.ui.kinds');
/** Hands the host's `KindsHost` to every kind editor beneath; the shell calls it once. */
export const provideKinds = (host: KindsHost) => setContext(KEY, host);
/** The `KindsHost` provided above, or an empty host. */
export const useKinds = (): KindsHost => getContext<KindsHost | undefined>(KEY) ?? {};
/** The keyless OpenStreetMap tile template used when the host names no basemap. */
export const DEFAULT_BASEMAP = {
	url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
	attribution: '&copy; OpenStreetMap contributors'
};

/** A region code's English name (`SG` → `Singapore`), or `null` when there is none or the runtime cannot name it. */
const regionName = (region: string | undefined): string | null => {
	if (region === undefined) return null;
	return Result.getOrElse(
		Result.try(() => new Intl.DisplayNames(['en'], { type: 'region' }).of(region) ?? null),
		() => null
	);
};
/** The region of a locale tag (`en-SG` → `SG`), or `undefined` when the tag names none. */
export const regionOf = (locale: string | undefined): string | undefined => {
	return locale === undefined
		? undefined
		: Result.getOrElse(
				Result.try(() => new Intl.Locale(locale).region),
				() => undefined
			);
};
// Photon (OpenStreetMap data) answers search-as-you-type without a key; Nominatim's policy forbids that use.
const PHOTON = 'https://photon.komoot.io';
const Place = Schema.optionalKey(Schema.String);
const PhotonAnswer = Schema.Struct({
	features: Schema.Array(
		Schema.Struct({
			geometry: Schema.Struct({ coordinates: Schema.Tuple([Schema.Number, Schema.Number]) }),
			properties: Schema.Struct({
				name: Place,
				housenumber: Place,
				street: Place,
				district: Place,
				postcode: Place,
				city: Place,
				state: Place,
				country: Place,
				countrycode: Place
			})
		})
	)
});
type Hit = {
	readonly point: Point;
	readonly address: string;
	readonly country?: string | undefined;
};
const photon = (
	path: string
): Effect.Effect<
	readonly Hit[],
	HttpClientError.HttpClientError | Schema.SchemaError,
	HttpClient.HttpClient
> =>
	HttpClient.get(`${PHOTON}${path}`).pipe(
		Effect.flatMap(HttpClientResponse.filterStatusOk),
		Effect.flatMap(HttpClientResponse.schemaBodyJson(PhotonAnswer)),
		Effect.map(({ features }) =>
			features.map(
				({
					geometry: {
						coordinates: [lng, lat]
					},
					properties: p
				}) => ({
					point: { lat, lng },
					country: p.countrycode,
					address: [
						...new Set([
							p.name,
							[p.housenumber, p.street].filter(Boolean).join(' '),
							p.district,
							[p.postcode, p.city].filter(Boolean).join(' '),
							p.state,
							p.country
						])
					]
						.filter((x) => x !== undefined && x !== '')
						.join(', ')
				})
			)
		)
	);
/**
 * The keyless geocoder as Effects: a worldwide search ranks a famous street abroad above the one next door ("40 Wilkinson
 * Road" is London's first), so with the workspace's region the query is also asked with that country's name (both at
 * once), and its places come first.
 */
export const photonGeocoder = {
	search: (q: string, options?: { region?: string }) => {
		const region = options?.region;
		const name = regionName(region);
		const ask = (text: string) => photon(`/api/?q=${encodeURIComponent(text)}&limit=5`);
		const near =
			name === null || q.toLowerCase().includes(name.toLowerCase())
				? Effect.succeed<readonly Hit[]>([])
				: ask(`${q}, ${name}`);
		return Effect.all({ near, all: ask(q) }, { concurrency: 'unbounded' }).pipe(
			Effect.map(({ near, all }) => {
				const home = (h: Hit) => h.country !== undefined && h.country === region;
				const seen = new Set<string>();
				return [...near.filter(home), ...all.filter(home), ...all.filter((h) => !home(h))]
					.filter((h) => !seen.has(h.address) && seen.add(h.address))
					.slice(0, 5)
					.map(({ point, address }) => ({ point, address }));
			}),
			Effect.provide(FetchHttpClient.layer)
		);
	},
	reverse: ({ lat, lng }: Point) =>
		photon(`/reverse?lat=${lat}&lon=${lng}`).pipe(
			Effect.map((hits) => hits[0]?.address ?? null),
			Effect.provide(FetchHttpClient.layer)
		)
};
