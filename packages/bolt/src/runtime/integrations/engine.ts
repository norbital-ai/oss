import { sha256Text } from '@norbital-ai/std/reckon/hash';
import type { ConflictRule, SyncDeclaration } from '#lib/authoring/integrations-schema.js';

/**
 * The sync engine's decisions, as pure functions (integrations.md §8).
 *
 * Nothing here reads a database or a source: it decides what a change means given the shadow both
 * sides last agreed on. That is what lets the convergence property be tested over random
 * interleavings without a provider.
 */

type Values = Readonly<Record<string, unknown>>;

/** JSON with object keys sorted: `jsonb` hands keys back in its own order. */
export const canonical = (value: unknown): string =>
	JSON.stringify(value ?? null, (_key, inner: unknown) =>
		inner !== null && typeof inner === 'object' && !Array.isArray(inner)
			? Object.fromEntries(
					Object.entries(inner).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				)
			: inner
	);

/**
 * Whether two field values are the same value, compared as values rather than spellings: the
 * database answers `numeric` as `"0.28"` and an instant in its own zone, where a source says `0.28`
 * and `…Z`.
 */
export const same = (left: unknown, right: unknown): boolean => {
	if (canonical(left) === canonical(right)) return true;
	if (typeof left === 'string' && typeof right === 'number') return Number(left) === right;
	if (typeof left === 'number' && typeof right === 'string') return Number(right) === left;
	if (typeof left === 'string' && typeof right === 'string') {
		if (!/^\d{4}-\d{2}-\d{2}/.test(left) || !/^\d{4}-\d{2}-\d{2}/.test(right)) return false;
		const [a, b] = [Date.parse(left), Date.parse(right)];
		return Number.isFinite(a) && a === b;
	}
	return false;
};

/** A version token for a source without one: a hash of the synced values. */
export const contentVersion = (values: Values): string => `sha256:${sha256Text(canonical(values))}`;

/**
 * How an incoming version relates to the stored one: `-1` older (drop it), `0` the same (a no-op),
 * `1` newer or incomparable-but-different (apply it). Numbers and instants order; any other token
 * only says same or different, and different is applied — a source whose versions do not order
 * cannot deliver out of order in a way the engine could see.
 */
export const versionOrder = (stored: string | null | undefined, incoming: string): -1 | 0 | 1 => {
	if (stored === null || stored === undefined) return 1;
	if (stored === incoming) return 0;
	const [a, b] = [Number(stored), Number(incoming)];
	if (stored.trim() !== '' && incoming.trim() !== '' && Number.isFinite(a) && Number.isFinite(b))
		return b > a ? 1 : b < a ? -1 : 0;
	if (/^\d{4}-\d{2}-\d{2}/.test(stored) && /^\d{4}-\d{2}-\d{2}/.test(incoming)) {
		const [x, y] = [Date.parse(stored), Date.parse(incoming)];
		if (Number.isFinite(x) && Number.isFinite(y)) return y > x ? 1 : y < x ? -1 : 0;
	}
	return 1;
};

export type Conflict = Readonly<{
	readonly field: string;
	readonly base: unknown;
	readonly local: unknown;
	readonly remote: unknown;
	readonly rule: ConflictRule;
	readonly winner: 'local' | 'remote';
}>;

export type Merge = Readonly<{
	/** Fields to write locally (only those that change). */
	readonly write: Values;
	/** Whether local state now differs from the remote's, so a push is owed. */
	readonly push: boolean;
	/** The new shadow: what the remote holds after this change. */
	readonly shadow: Values;
	readonly conflicts: ReadonlyArray<Conflict>;
}>;

const ruleFor = (sync: SyncDeclaration, field: string): ConflictRule =>
	sync.conflicts.fields[field] ?? sync.conflicts.default;

/**
 * Applies one remote record to one linked local row (§8.2).
 *
 * `base` is the shadow, `local` the row as stored, `remote` the incoming values in local form.
 * For a one-way sync the remote always wins. For a two-way sync each synced field is merged against
 * the base: whoever changed it wins; both changed to the same value converged; both changed apart
 * is a conflict the declared rule settles, and the conflict is returned to be logged. A field the
 * remote owns always takes the remote's value; a field we own is never overwritten by it.
 * `base === undefined` is an adoption (first sync matched an existing row): there is no agreed
 * state yet, so every differing field is a conflict.
 */
export const mergeRemote = (
	sync: SyncDeclaration,
	base: Values | undefined,
	local: Values,
	remote: Values,
	times: Readonly<{ readonly local?: string | null; readonly remote?: string | null }> = {}
): Merge => {
	const write: Record<string, unknown> = {};
	const conflicts: Array<Conflict> = [];
	let push = false;
	for (const { column } of sync.fields) {
		if (!(column in remote)) continue;
		const theirs = remote[column];
		const ours = local[column];
		if (same(ours, theirs)) continue;
		if (sync.direction === 'one_way' || sync.owns.remote.includes(column)) {
			write[column] = theirs;
			continue;
		}
		if (sync.owns.local.includes(column)) {
			push = true;
			continue;
		}
		const was = base?.[column];
		const localChanged = base === undefined || !same(ours, was);
		const remoteChanged = base === undefined || !same(theirs, was);
		if (!localChanged) {
			write[column] = theirs;
			continue;
		}
		if (!remoteChanged) {
			push = true;
			continue;
		}
		const rule = ruleFor(sync, column);
		const remoteWins =
			rule === 'remote_wins' ||
			(rule === 'latest' && !(Date.parse(times.local ?? '') > Date.parse(times.remote ?? '')));
		conflicts.push({ field: column, base: was, local: ours, remote: theirs, rule, winner: remoteWins ? 'remote' : 'local' });
		if (remoteWins) write[column] = theirs;
		else push = true;
	}
	return { write, push, shadow: { ...remote }, conflicts };
};

/** The pushed fields where the row differs from the shadow: what a local edit owes the source. */
export const localChanges = (sync: SyncDeclaration, shadow: Values, row: Values): Values =>
	Object.fromEntries(
		sync.fields
			.filter(({ column, pushed }) => pushed && !sync.owns.remote.includes(column) && !same(row[column], shadow[column]))
			.map(({ column }) => [column, row[column]])
	);

/** The synced columns a row carries, in local form: a shadow's shape. */
export const syncedValues = (sync: SyncDeclaration, row: Values): Values =>
	Object.fromEntries(sync.fields.filter(({ column }) => column in row).map(({ column }) => [column, row[column]]));

/**
 * Which columns of a write a principal other than the sync subject may not touch (§6).
 *
 * A one-way mirror owns its synced columns and the row's existence; a two-way sync's remote-owned
 * columns belong to the source. Local-only columns are always writable.
 */
export const ownedColumns = (sync: SyncDeclaration): ReadonlyArray<string> =>
	sync.direction === 'one_way' ? [...sync.fields.map(({ column }) => column), sync.identity] : sync.owns.remote;
