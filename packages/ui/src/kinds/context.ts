// What the kit's renderers and editors learn from the shell, once per page (hook:ui-shell sets `provideKinds` beside
// `provideBolt`): the collections' exposure, the workspace's custom fields, and the optional facilities the host has.
// Every optional member absent is a working page: files show names, points search with the keyless geocoder.
import { getContext, setContext, type Component } from 'svelte';
import type { FileRef, Fields, Json, Kind, Point } from './kind.js';

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
	relations?: { readonly [fk: string]: { targets: readonly string[]; optional?: true; label?: string; inverse?: string } };
	/** Many-relations (inverses) the collection exposes; each child is the collection whose relation names it as `inverse`. */
	many?: readonly string[];
	/** Fields masked to this caller (rule 14): shown locked, never offered to filter or sort. */
	masked?: readonly string[];
	create?: { columns: readonly string[] };
	update?: { columns: readonly string[] };
	actions?: { readonly [action: string]: { input: Fields; target?: 'record'; description?: string } };
	/** The view toolbar's info text: the collection's declared description, else its model's. */
	description?: string;
	/** The caller holds a delete arm. */
	delete?: true;
	/** The collection has an integration whose `<c>.integration` run the caller may start. */
	integration?: true;
	/** The `<c>.pipeline` feeds the caller may run, by their declared description. */
	pipeline?: { import?: string; export?: string };
};
/** What a custom field's renderer receives, a tenant's `src/data/custom_field/<f>/+renderer.svelte` and a built-in's
 * (`money`, `file`, `point`, `phone`) alike (§3.2 role 5). `row` is the record's other field values (the form's draft in
 * edit mode), absent when a page embeds the renderer; `kind` is the field's literal (a custom reference's `shape`);
 * `dense` asks for one compact line (a table cell, a card); `address` is a `point` field's address sibling. */
type ViewCommon<V> = {
	name: string; value: V | null; row?: { readonly [f: string]: Json }; kind?: Kind; id?: string;
	address?: { value: string | null; onChange?(next: string | null): void };
};
/** What a custom field's renderer receives: its value and, in `edit` mode, `onChange`, `disabled` and the field's error. */
export type CustomFieldView<V = Json> =
	| (ViewCommon<V> & { mode: 'show'; dense?: true })
	| (ViewCommon<V> & { mode: 'edit'; disabled: boolean; error?: string; onChange(next: V | null): void });
/** A custom field as the ui renders it: its shape, label and optional renderer component; built-ins and tenant fields alike. */
export type CustomFieldEntry = { shape: Kind; label?: string; renderer?: Component<{ view: CustomFieldView }> };
/** The host's address search (and reverse lookup) a `PointInput` uses when present. */
export type Geocoder = {
	search(query: string): Promise<readonly { point: Point; address: string }[]>;
	reverse?(point: Point): Promise<string | null>;
};
/**
 * What the kind editors take from the host: the catalog, custom fields, uploads and file URLs, the geocoder and basemap, the picker's read, locale, zone and default currency.
 */
export type KindsHost = {
	catalog?: { readonly [collection: string]: CollectionExposure };
	customFields?: { readonly [name: string]: CustomFieldEntry };
	/** `bolt.upload`; without it a file field is read-only. */
	upload?(file: File, field: string): Promise<FileRef>;
	fileUrl?(ref: FileRef): string;
	/** The host's geocoder (P19); without one, address search uses the keyless `DEFAULT_GEOCODER`. */
	geocoder?: Geocoder;
	/** A keyless tile template; the host may override the OpenStreetMap default. */
	basemap?: { url: string; attribution: string };
	/** The `read` a picker pages through: `bolt.read`. Without it an `id` is typed. */
	read?(collection: string, options: Json): PromiseLike<{ rows: readonly { readonly [f: string]: Json }[]; next: string | null }>;
	locale?: string;
	zone?: string;
	/** The workspace default currency for a money field without one (X-8). */
	currency?: string;
};

const KEY = Symbol.for('norbital.ui.kinds');
/** Hands the host's `KindsHost` to every kind editor beneath; the shell calls it once. */
export const provideKinds = (host: KindsHost) => setContext(KEY, host);
/** The `KindsHost` provided above, or an empty host. */
export const useKinds = (): KindsHost => getContext<KindsHost | undefined>(KEY) ?? {};
/** The keyless OpenStreetMap tile template used when the host names no basemap. */
export const DEFAULT_BASEMAP = { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '&copy; OpenStreetMap contributors' };

// Photon (OpenStreetMap data) answers search-as-you-type without a key; Nominatim's policy forbids that use.
const PHOTON = 'https://photon.komoot.io';
type PhotonFeature = { geometry: { coordinates: [number, number] }; properties: { [k: string]: string | undefined } };
const photon = async (path: string): Promise<readonly { point: Point; address: string }[]> => {
	const res = await fetch(`${PHOTON}${path}`);
	if (!res.ok) throw new Error(`geocoder ${res.status}`);
	const { features } = (await res.json()) as { features: readonly PhotonFeature[] };
	return features.map(({ geometry: { coordinates: [lng, lat] }, properties: p }) => ({
		point: { lat, lng },
		address: [...new Set([p['name'], [p['housenumber'], p['street']].filter(Boolean).join(' '), p['district'], [p['postcode'], p['city']].filter(Boolean).join(' '), p['state'], p['country']])]
			.filter((x) => x !== undefined && x !== '').join(', ')
	}));
};
/** The keyless geocoder a `point` field searches with when the host names none. */
export const DEFAULT_GEOCODER: Geocoder = {
	search: (q) => photon(`/api/?q=${encodeURIComponent(q)}&limit=5`),
	reverse: async ({ lat, lng }) => (await photon(`/reverse?lat=${lat}&lon=${lng}`))[0]?.address ?? null
};
