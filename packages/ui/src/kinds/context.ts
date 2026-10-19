// What the kit's renderers and editors learn from the shell, once per page (hook:ui-shell sets `provideKinds` beside
// `provideBolt`): the collections' exposure, the workspace's custom fields, and the optional facilities the host has.
// Every optional member absent is a working page: files show names, points search with the keyless geocoder.
import { Effect, Result, Schema } from 'effect';
import {
	FetchHttpClient,
	HttpClient,
	HttpClientResponse,
	type HttpClientError
} from 'effect/unstable/http';
import { getContext, setContext, type Component } from 'svelte';
import type { ActFailure, ReadError } from '../client/contract.js';
import type { FileRef, Fields, Json, Kind, Point, Value } from './kind.js';
import type { FileUrlOptions } from '@norbital-ai/std/kind';

export type ChildInput = {
	collection: string;
	parent: string;
	owned?: true;
	create?: { columns: readonly string[]; filled?: readonly string[]; proposalOnly?: true };
	update?: { columns: readonly string[] };
	delete?: true;
	link?: true;
	unlink?: true;
};

/** One collection as a form and a picker need it (generated from `+collection.ts` and the model). */
export type CollectionExposure = {
	/** The model's `label` fields: a record's title and the picker's search fallback. */
	label: readonly string[];
	/** Search fields when the model declares `search.text`; else the picker searches `label`'s text fields. */
	search?: readonly string[];
	/** The model declares `search.semantic` (text or file fields on an embedding model): the toolbar offers `/semantic`. */
	semantic?: true;
	/** The named similarity searches the caller reads, by their typed `input`: the toolbar offers each as `/<name>`. */
	similarity?: { readonly [name: string]: { input: Fields; description: string } };
	/** The collection's named queries the caller holds, by their typed `input` and `output`: the toolbar offers each as `/<query>`. */
	queries?: { readonly [query: string]: { input: Fields; output: Kind; description: string } };
	/** Model fields the caller may read (hidden ones included; `hidden` renders nothing). */
	fields: Fields;
	/** One-relations as FK columns: `holder` → `employees`. A polymorphic ref lists every target. */
	relations?: {
		readonly [fk: string]: {
			targets: readonly string[];
			optional?: true;
			label?: string;
			inverse?: string;
		};
	};
	/** Many-relations (inverses) the collection exposes; each child is the collection whose relation names it as `inverse`. */
	many?: readonly string[];
	/** Read-side inverse identities; each child is read independently through its own policy. */
	children?: Readonly<Record<string, Pick<ChildInput, 'collection' | 'parent' | 'owned'>>>;
	/** Fields masked to this caller (rule 14): shown locked, never offered to filter or sort. */
	masked?: readonly string[];
	create?: {
		columns: readonly string[];
		filled?: readonly string[];
		proposalOnly?: true;
		with?: Readonly<Record<string, ChildInput>>;
	};
	update?: { columns: readonly string[]; with?: Readonly<Record<string, ChildInput>> };
	/** Host-declared field restrictions, in addition to ordinary write grants. */
	readonlyFields?: { readonly [field: string]: 'integrationOwned' | 'ownedParent' };
	actions?: {
		readonly [action: string]: { input: Fields; target?: 'record'; description?: string };
	};
	/** The view toolbar's info text: the collection's declared description, else its model's. */
	description?: string;
	/** The caller holds a delete arm. */
	delete?: true;
	/** The declared feed run (`<definition>.<feed>`) the caller may start for this collection. */
	integration?: string;
	/** The `<c>.pipeline` import and export the caller may run, by their declared description. */
	pipeline?: { import?: string; export?: string };
};
/** What a custom field's renderer receives, a tenant's `src/data/custom_field/<f>/+renderer.svelte` and a built-in's
 * (`money`, `file`, `point`, `phone`) alike (§3.2 role 5). `row` is the record's other field values (the form's draft in
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
/** What a custom field's renderer receives: its value and, in `edit` mode, `onChange`, `disabled` and the field's error. */
export type CustomFieldView<V = Value> =
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
	renderer?: Component<{ view: CustomFieldView }>;
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
	catalog?: { readonly [collection: string]: CollectionExposure } | undefined;
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
	/** The `read` a picker pages through: `bolt.read`. Without it an `id` is typed. */
	read?(
		collection: string,
		options: Json
	): Effect.Effect<
		{
			rows: readonly ({ readonly id: string } & { readonly [f: string]: Value })[];
			next: string | null;
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
