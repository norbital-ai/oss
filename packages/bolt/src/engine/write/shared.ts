// Shared leaf types and pure helpers for the write planner: keys, refusals, callback answers, tree shaping, and rules.
import { Effect, Predicate } from 'effect';
import { canonical, type Catalog, type SelectIR } from '@norbital-ai/store';
import type { ApprovalSnapshot } from '../../decl/access/policy.ts';
import type { Json } from '../../decl/values.ts';
import { BoltError } from '../../protocol/errors.ts';
import { sync_owned } from '../access/authority.ts';
import type { Holder } from '../approvals/lock.ts';
import { writeFields, writeTarget } from '../callables/parse.ts';
import {
	LIMITS,
	type Authority,
	type Bindings,
	type Change,
	type InputPath,
	type Invocation,
	type Outcome,
	type RowData
} from '../contracts.ts';
import type { TenantDbShape as TenantDb } from '../db/tenant-db.ts';
import type { EngineError } from '../errors.ts';
import type { EngineManifest } from '../manifest.ts';
import type {
	ActRequest,
	Bridge,
	GuestShape as GuestPort,
	InvocationEvents,
	PlannedCommit,
	ReadsShape
} from '../services.ts';
import type { Commit, Write } from './commit.ts';
import type { Item } from './flatten.ts';
import type { ImportPlan } from './import.ts';
import type { Fingerprint } from './sql.ts';

export const jsonArray = (value: Json | undefined): value is readonly Json[] => Array.isArray(value);

/** The generated verbs: `import` and `erase` included. */
export type Verb = 'create' | 'update' | 'delete' | 'upsert' | 'import' | 'erase';
/** The snapshot that opens or resumes a request. */
export type StepsSnapshot = Extract<ApprovalSnapshot, { kind: 'steps' }>;
export type HeldRecord = {
	readonly id: string;
	readonly action: 'create' | 'update' | 'delete';
	readonly values: RowData;
};
/** Approval persistence belongs to the approval engine; the write engine evaluates the grant's callback. */
export interface ApprovalHook {
	route(act: {
		readonly model: string;
		readonly record: string;
		readonly action: 'create' | 'update' | 'delete';
		readonly authority: Authority;
		readonly bindings: Bindings;
		readonly seed: string;
		readonly snapshot: StepsSnapshot;
		readonly records: readonly HeldRecord[];
	}): Effect.Effect<NonNullable<Commit['approval']> | Outcome, EngineError>;
	resubmit(act: {
		readonly request: string;
		readonly authority: Authority;
		readonly bindings: Bindings;
		readonly snapshot: StepsSnapshot | { readonly kind: 'allow' };
		readonly changed: readonly {
			readonly model: string;
			readonly id: string;
			readonly fields: readonly string[];
		}[];
		readonly records: readonly HeldRecord[];
	}): Effect.Effect<NonNullable<Commit['resubmit']>, EngineError>;
}
export type WriteEngine = {
	log?: InvocationEvents;
	manifest: EngineManifest;
	db: TenantDb;
	guest?: GuestPort;
	/** Reads as the caller: whether a person may write a file ref they name (`writableFile`). */
	read?: ReadsShape['run'];
	/**
	 * The transform's reads as the workspace; `tables()` names what it read, for the transform lock, and
	 * `fingerprints()` digests them, for the transform assert.
	 */
	bridge?: (
		invocation: Invocation,
		db?: TenantDb
	) => Bridge & {
		tables?(): readonly string[];
		fingerprints?(): readonly Fingerprint[];
	};
	approval?: ApprovalHook;
};
export type Probe = Pick<WriteEngine, 'manifest' | 'db' | 'guest' | 'bridge'>;
export type Taker = (
	severity: 'info' | 'warn',
	event: string,
	attributes: {
		readonly [key: string]: Json;
	}
) => Effect.Effect<void>;
export type Judged = 'create' | 'update' | 'delete';
export type CheckArm = { readonly policy: string; readonly check: boolean };
/** Per verb, the arms that admit the act's whole batch there; each one's `check`, when declared, judges it. */
export type Admitted = { readonly [verb in Judged]?: readonly CheckArm[] };
export type Need = { readonly path: string; readonly field?: string; readonly row?: number };
export type Judgement =
	| { readonly kind: 'allow' }
	| { readonly kind: 'approve'; readonly flow: StepsSnapshot }
	| { readonly kind: 'refuse'; readonly outcome: Outcome };
export type ReadVisibility = {
	authority: Authority;
	bindings: Bindings;
	visibility: Map<string, boolean>;
	/**
	 * With it, which rows each held `update` / `delete` grant's own scope admits, keyed `verb␀model␀id` (see
	 * `writePredicates`): what an update or delete may target, never the union of readable outputs.
	 */
	writable?: Map<string, boolean>;
	/** The visibility reads' digests, for the commit to assert: a row that left the caller's scope since is a conflict. */
	fingerprints: Fingerprint[];
};
export type StoppedPlan = { guest: boolean; outcome: Outcome };
export type Planned = StoppedPlan | (PlannedCommit & { guest: boolean });
export type ImportRow = { index: number | null; id: string | null; action: string };
export type DraftWrite = { write: Write; item: Item };
export type PlanInput = {
	e: WriteEngine;
	r: ActRequest;
	cat: Catalog;
	submitted: readonly Item[];
	pre: Map<string, RowData>;
	imp: ImportPlan | undefined;
	own: TenantDb;
	visibility: Map<string, boolean>;
	admitted: Admitted | undefined;
	/** The open requests holding any of the refs (`heldBy`): each ref is asked of the database once per plan. */
	held: (
		refs: readonly (readonly [string, string])[]
	) => Effect.Effect<readonly Holder[], EngineError>;
};
export type PreparedPlan = {
	guest: boolean;
	items: Item[];
	flow: StepsSnapshot | undefined;
	importRows: ImportRow[];
	upsertOutput: string[];
	readTables: Set<string>;
	/** The tables the callbacks' own reads (`ctx.query`) touched, whole: a moved field of one is read. */
	guestTables: Set<string>;
	fingerprints: Fingerprint[];
};
export type DraftPlan = {
	writes: DraftWrite[];
	unchanged: { model: string; id: string }[];
	report: ImportRow[];
};
export type RoutedPlan = {
	guest: boolean;
	approval: Commit['approval'];
	resubmit: Commit['resubmit'];
};

type RefusalCode = Extract<Outcome, { kind: 'refused' }>['code'];
export const refused = (code: RefusalCode, message: string, path?: InputPath): Outcome => {
	const field = path?.findLast(
		(p) =>
			typeof p === 'string' &&
			!['set', 'target', 'create', 'update', 'upsert', 'delete', 'link', 'unlink'].includes(p)
	);
	const row = path?.find((p) => typeof p === 'number');
	return {
		kind: 'refused',
		code,
		message,
		...(typeof field === 'string' ? { field } : {}),
		...(typeof row === 'number' ? { row } : {})
	};
};
export const missing_record = (path?: InputPath) =>
	refused('not_found', 'The record does not exist.', path);
export const guest_port = (guest: WriteEngine['guest']) =>
	guest === undefined
		? Effect.fail(BoltError.make('no_guest', 'guest', 'this host runs no guest code'))
		: Effect.succeed(guest);
export const guest_context = (actor: Authority['actor'], b: Bindings, seed: string) => ({
	actor,
	now: b.now,
	today: b.today,
	tz: b.tz,
	seed
});
export const k = (model: string, id: string) => `${model}\u0000${id}`;
/** The record a change names: an upsert by id names the stored row, any other change its own id. */
export const named = (c: Change): string =>
	c.op === 'upsert' && c.on.length === 1 && c.on[0] === 'id' && typeof c.values['id'] === 'string'
		? c.values['id']
		: c.id;
/** The verb a change is judged by: an upsert of a stored row updates it, any other upsert creates. */
export const actionOf = (c: Change, pre: ReadonlyMap<string, RowData>): Judged =>
	c.op === 'upsert' ? (pre.has(k(c.model, named(c))) ? 'update' : 'create') : c.op;
export const stateField = (m: EngineManifest, model: string): string | undefined =>
	Object.entries(m.models[model]?.fields ?? {}).find(([, x]) => x.kind === 'state')?.[0];
export const hasCallback = (
	m: EngineManifest,
	model: string,
	verb: 'create' | 'update' | 'delete'
): boolean => m.exposures[model]?.[verb]?.transform === true;

/** A write callback's stored tree: each declared child layer, refusing a list beyond the native bound. */
export const treeSelect = (
	cat: Catalog,
	paths: readonly string[],
	path: string,
	model: string
): SelectIR => ({
	fields: null,
	relations: Object.fromEntries(
		paths.flatMap((p) => {
			const rel = p.startsWith(`${path}.`) ? p.slice(path.length + 1) : '';
			const many =
				rel === '' || rel.includes('.') ? undefined : cat.models.get(model)?.many.get(rel);
			return many === undefined
				? []
				: [
						[
							rel,
							{
								target: many.child,
								many: true,
								select: treeSelect(cat, paths, p, many.child),
								page: { _tag: 'Limit' as const, limit: LIMITS.page.max + 1 }
							}
						]
					];
		})
	)
});
/** Write callbacks expose writable stored values and system metadata, never stale generated values. */
export const writeTree = (cat: Catalog, model: string, row: RowData | null): RowData | null =>
	row === null
		? null
		: Object.fromEntries(
				Object.entries(row).flatMap(([name, value]): readonly (readonly [string, Json])[] => {
					const field = cat.models.get(model)?.fields.get(name);
					if (
						field?.computed ||
						field?.derived ||
						(field !== undefined && ['seq', 'sum', 'count'].includes(field.kind))
					)
						return [];
					const relation = cat.models.get(model)?.many.get(name);
					if (relation === undefined) return [[name, value]];
					if (!jsonArray(value))
						throw BoltError.make(
							'internal',
							'decode',
							`The stored write tree is missing ${model}.${name}.`
						);
					if (value.length > LIMITS.page.max)
						throw BoltError.make(
							'too_large',
							'admission',
							`The stored ${model}.${name} exceeds the write tree limit.`
						);
					return [
						[
							name,
							value.map((child) => {
								if (!Predicate.isObject(child) || typeof child['id'] !== 'string')
									throw BoltError.make(
										'internal',
										'decode',
										`The stored write tree has an invalid ${model}.${name} row.`
									);
								return writeTree(cat, relation.child, child);
							})
						]
					];
				})
			);

export const changeToken = (item: Item) => canonical([item.change.model, item.change.path]);
export const descendantOf = (item: Item, root: Item) =>
	item !== root &&
	item.change.path.length > root.change.path.length &&
	root.change.path.every((part, at) => item.change.path[at] === part);
export const changeDepth = (item: Item) =>
	item.change.path.filter(
		(part, index) =>
			typeof part === 'string' &&
			typeof item.change.path[index + 1] === 'number' &&
			['create', 'update', 'upsert', 'delete', 'link', 'unlink'].includes(part)
	).length;

/** The refs the approval lock weighs for `writes`: each stored row, and the stored owned parent of each. */
export const holdRefs = (
	m: EngineManifest,
	cat: Catalog,
	pre: ReadonlyMap<string, RowData>,
	writes: readonly Write[]
): (readonly [string, string])[] => {
	const fresh = new Set(
		writes.filter((write) => write.op === 'create').map((write) => k(write.model, write.id))
	);
	return writes.flatMap((write): (readonly [string, string])[] => [
		...(write.op === 'create' ? [] : [[write.model, write.id] as const]),
		...[...(cat.models.get(write.model)?.one ?? [])].flatMap(([fk, one]) => {
			const parent =
				write.op === 'create' ? write.values[fk] : pre.get(k(write.model, write.id))?.[fk];
			const target = one.targets[0];
			return m.relationships[`${write.model}.${fk}`]?.owned &&
				target !== undefined &&
				typeof parent === 'string' &&
				!fresh.has(k(target, parent))
				? [[target, parent] as const]
				: [];
		})
	]);
};
/** The writes the submitted items name before any callback, as `holdRefs` weighs them. */
export const guessed = (items: readonly Item[], pre: ReadonlyMap<string, RowData>): Write[] =>
	items.map(({ change: c }): Write =>
		actionOf(c, pre) === 'create'
			? {
					model: c.model,
					id: named(c),
					op: 'create',
					values: c.op === 'update' ? c.set : c.op === 'delete' ? {} : c.values
				}
			: { model: c.model, id: named(c), op: 'update', set: {}, revision: 0 }
	);

export function syncOwnership(m: EngineManifest, r: ActRequest, items: readonly Item[]): Outcome | null {
	const { sync } = r.mode;
	for (const { change: c } of items) {
		const written =
			c.op === 'update'
				? Object.keys(c.set)
				: c.op === 'delete'
					? []
					: Object.keys(c.values).filter((field) => field !== 'id');
		if (sync !== undefined) {
			if (c.model !== r.model)
				return refused('forbidden', `A sync writes only ${r.model}.`, c.path);
			const field = written.find((field) => !sync.fields.includes(field));
			if (field !== undefined)
				return refused('forbidden', `'${field}' of ${c.model} is outside this sync's fields.`, [
					...c.path,
					field
				]);
			continue;
		}
		const owned = sync_owned(m, c.model);
		if (owned === undefined) continue;
		if (c.op !== 'update')
			return refused('forbidden', `${c.model} is written by its sync ${owned.sync}.`, c.path);
		const field = written.find((field) => !owned.local.includes(field));
		if (field !== undefined)
			return refused('forbidden', `'${field}' of ${c.model} is written by its sync ${owned.sync}.`, [
				...c.path,
				field
			]);
	}
	return null;
}

/**
 * The model rules the native rules cannot see: an enum's declared `transitions` and an owned child's fixed parent key.
 * Locks, state moves and owned parents' locks are the native rules' (store `rules.ts`), refused at commit.
 */
export function appRules(
	m: EngineManifest,
	model: string,
	row: RowData,
	set: RowData
): { message: string; field: string } | null {
	for (const [field, kind] of Object.entries(m.models[model]?.fields ?? {}))
		if (kind.kind === 'enum' && kind.transitions !== undefined && set[field] !== undefined) {
			const from = String(row[field] ?? ''),
				next = String(set[field]);
			if (from !== next && !(kind.transitions[from] ?? []).includes(next))
				return { message: `'${from}' cannot move to '${next}'.`, field };
		}
	for (const fk of Object.keys(set))
		if (m.relationships[`${model}.${fk}`]?.owned)
			return { message: 'An owned record never changes its parent.', field: fk };
	return null;
}

/**
 * What a failed guest invocation answers. A throw from tenant code is `internal` (its message reaches
 * members only); a budget keeps its own code; anything else is a platform fault, thrown with its cause.
 */
export function guestFailure(error: BoltError): Effect.Effect<Outcome, BoltError> {
	switch (error.code) {
		case 'guest_error':
		case 'internal':
			return Effect.succeed(refused('internal', error.message));
		case 'read_budget_exceeded':
		case 'cpu_budget':
		case 'crossing_budget':
		case 'memory':
		case 'too_large':
			return Effect.succeed(refused(error.code, error.message));
		default:
			return Effect.fail(error);
	}
}

/** The path segments under which a write's carried rows sit, one level below the rows that carry them. */
export const CARRIED = '$with';
export const APPROVED = '$on_approved';
/** A carried row: under a callback's `with` or `on_approved`, or a row of an approved write's `on_approved` act. */
export const carried = (r: ActRequest, item: Item) =>
	r.mode.carriedBy !== undefined ||
	item.change.path.includes(CARRIED) ||
	item.change.path.includes(APPROVED);
/** A create transform reads its row's id; the id it answers is the act's own, never a value. */
export const withoutId = (row: Json | undefined) => {
	if (!record(row)) return row;
	const { id: _id, ...rest } = row;
	return rest;
};
/** A JSON object, narrowed so its values stay JSON. */
export const record = (value: Json | undefined): value is { readonly [key: string]: Json } =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
export type CarriedWrite =
	| { readonly model: string; readonly op: 'create'; readonly index: number; readonly row: Json }
	| {
			readonly model: string;
			readonly op: 'update';
			readonly index: number;
			readonly target: { readonly id: string; readonly revision?: number };
			readonly set: RowData;
	  };
/**
 * The callback returns its sets in input order, with optional carried writes in the same commit or on approval. A delete
 * returns no sets: nothing, or only what it carries.
 */
export const answerOf = (
	verb: 'create' | 'update' | 'delete',
	output: Json,
	count: number,
	m: EngineManifest,
	rootModel: string
):
	| {
			readonly sets: readonly Json[];
			readonly with: readonly CarriedWrite[];
			readonly on_approved: readonly CarriedWrite[];
	  }
	| string => {
	try {
		const whole = record(output) ? output : undefined;
		if (verb === 'delete' && output !== null && (whole === undefined || 'sets' in whole))
			return 'a delete callback returns nothing, or only with and on_approved';
		if (
			whole !== undefined &&
			Object.keys(whole).some((key) => !['sets', 'with', 'on_approved'].includes(key))
		)
			return 'a callback answer contains only sets, with and on_approved';
		const sets = verb === 'delete' ? [] : whole === undefined ? output : (whole['sets'] ?? null);
		if (!Array.isArray(sets) || (verb !== 'delete' && sets.length !== count))
			return 'a write callback returns one set per input';
		const groups: { with: CarriedWrite[]; on_approved: CarriedWrite[] } = {
			with: [],
			on_approved: []
		};
		for (const key of ['with', 'on_approved'] as const) {
			const declared = whole?.[key];
			if (declared === undefined) continue;
			if (!record(declared)) return `${key} maps a model to its creates and updates`;
			for (const [model, spec] of Object.entries(declared)) {
				if (!record(spec)) return `${key}.${model} holds create and update lists`;
				const { create = [], update = [], ...rest } = spec;
				if (Object.keys(rest).length > 0 || !Array.isArray(create) || !Array.isArray(update))
					return `${key}.${model} holds create and update lists`;
				create.forEach((row, index) =>
					groups[key].push({ model, op: 'create', index, row: writeFields(m, model, row, 'create') })
				);
				for (const [index, change] of update.entries()) {
					const at = `${key}.${model}.update[${index}]`;
					if (
						!record(change) ||
						Object.keys(change).some((field) => field !== 'target' && field !== 'set')
					)
						return `${at} is { target, set }`;
					const target = writeTarget(m, model, change['target']);
					const set = change['set'];
					if (!record(set)) return `${at}.set must be an object`;
					const normalized = writeFields(m, model, set, 'update');
					if (!record(normalized)) return `${at}.set must be an object`;
					groups[key].push({ model, op: 'update', index, target, set: normalized });
				}
			}
		}
		return {
			sets: verb === 'delete' ? [] : sets.map((set) => writeFields(m, rootModel, set, verb)),
			...groups
		};
	} catch (error) {
		return error instanceof BoltError ? error.message : String(error);
	}
};
