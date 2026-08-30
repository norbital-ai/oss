import type {
	StoredRecord,
	SyncAnswer,
	SyncHeldCoordinate,
	SyncQueryInput
} from '@norbital-ai/bolt-protocol';
import { canonicalJson } from '#lib/canonical-json.js';

export { canonicalJson } from '#lib/canonical-json.js';

const coordinate = (row: Readonly<Record<string, unknown>>): ReadonlyArray<unknown> => [
	typeof row['id'] === 'string' ? row['id'] : null,
	typeof row['row_version'] === 'number' || typeof row['row_version'] === 'string'
		? row['row_version']
		: null
];

/** Canonical JSON for content a coordinate cannot name: a projected answer carries no `id`. */
const canonicalContent = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(canonicalContent);
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value)
				.toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.map(([key, nested]) => [key, canonicalContent(nested)])
		);
	}
	return value;
};

const rowMaterial = (row: Readonly<Record<string, unknown>>): unknown =>
	typeof row['id'] === 'string' ? coordinate(row) : ['content', canonicalContent(row)];

/** One runtime shape per `SyncAnswer` arm. `StoredRecord` is an open record of `Json`, so it is
 * structurally compatible with the grouped record and neither type predicate nor `in` can split
 * them; shape tests plus a bounded cast at this single boundary is the honest form. */
type AnswerShape =
	| { readonly kind: 'scalar'; readonly value: number }
	| { readonly kind: 'empty' }
	| { readonly kind: 'list'; readonly rows: ReadonlyArray<StoredRecord> }
	| { readonly kind: 'row'; readonly row: StoredRecord }
	| {
			readonly kind: 'groups';
			readonly groups: Readonly<Record<string, ReadonlyArray<StoredRecord>>>;
	  };

const answerShape = (answer: SyncAnswer): AnswerShape => {
	if (typeof answer === 'number') return { kind: 'scalar', value: answer };
	if (answer === null) return { kind: 'empty' };
	if (Array.isArray(answer)) return { kind: 'list', rows: answer };
	const entries = Object.entries(answer);
	return entries.every(([, value]) => Array.isArray(value))
		? {
				kind: 'groups',
				groups: answer as Readonly<Record<string, ReadonlyArray<StoredRecord>>>
			}
		: { kind: 'row', row: answer as StoredRecord };
};

/** Canonical answer material: authoritative order plus each row's identity and version. */
const syncDigestMaterial = (answer: SyncAnswer): unknown => {
	const shape = answerShape(answer);
	switch (shape.kind) {
		case 'scalar':
			return ['scalar', shape.value];
		case 'empty':
			return ['empty'];
		case 'list':
			return ['rows', shape.rows.map(rowMaterial)];
		case 'row':
			return ['row', rowMaterial(shape.row)];
		case 'groups':
			return [
				'groups',
				Object.entries(shape.groups)
					.toSorted(([left], [right]) => left.localeCompare(right))
					.map(([group, rows]) => [group, rows.map(coordinate)])
			];
	}
};

/** Ordered root ids retained by the host for positional delta classification. */
export const heldIdsOf = (answer: SyncAnswer): ReadonlyArray<string> => {
	const shape = answerShape(answer);
	switch (shape.kind) {
		case 'scalar':
		case 'empty':
			return [];
		case 'list':
			return shape.rows.flatMap((row) => (typeof row['id'] === 'string' ? [row['id']] : []));
		case 'row':
			return typeof shape.row['id'] === 'string' ? [shape.row['id']] : [];
		case 'groups':
			return Object.entries(shape.groups)
				.toSorted(([left], [right]) => left.localeCompare(right))
				.flatMap(([, rows]) =>
					rows.flatMap((row) => (typeof row['id'] === 'string' ? [row['id']] : []))
				);
	}
};

const orderColumnsOf = (input: SyncQueryInput): ReadonlyArray<string> => {
	const columns =
		input.orderBy !== null && typeof input.orderBy === 'object' && !Array.isArray(input.orderBy)
			? Object.entries(input.orderBy).flatMap(([column, direction]) =>
					direction === 'asc' || direction === 'desc' ? [column] : []
				)
			: [];
	return columns.includes('id') ? columns : [...columns, 'id'];
};

/** Point/rank base retained by the host. Empty means this answer must use full-resolution fallback. */
export const heldCoordinatesOf = (
	answer: SyncAnswer,
	input: SyncQueryInput
): ReadonlyArray<SyncHeldCoordinate> => {
	if (input.kind !== 'findMany' || !Array.isArray(answer)) return [];
	const orderColumns = orderColumnsOf(input);
	return answer.flatMap((row) => {
		const id = row['id'];
		if (typeof id !== 'string' || id.length === 0) return [];
		const order = orderColumns.map((column) => row[column]);
		if (order.some((value) => value === undefined)) return [];
		const version = row['row_version'];
		return [
			{
				id,
				rowVersion: typeof version === 'number' || typeof version === 'string' ? version : null,
				order: order as SyncHeldCoordinate['order']
			}
		];
	});
};

const sha256 = async (value: unknown): Promise<string> => {
	const bytes = new TextEncoder().encode(canonicalJson(value));
	const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
	return `sha256:${[...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')}`;
};

/** List digest derived from minimal coordinates after an exact positional patch. */
export const contentDigestFromHeldCoordinates = (
	coordinates: ReadonlyArray<SyncHeldCoordinate>
): Promise<string> => sha256(['rows', coordinates.map(({ id, rowVersion }) => [id, rowVersion])]);

/** A history-independent SHA-256 over the answer's content coordinate. */
export const contentDigest = (answer: SyncAnswer): Promise<string> =>
	sha256(syncDigestMaterial(answer));

/** Stable guest-side hashing for policy and query source material. */
export const stableDigest = sha256;
