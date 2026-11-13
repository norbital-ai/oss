// Logical queries compile into three retained-view forms; row, counter and metadata changes share one lane.
import { Effect, Option, Predicate, Schema } from 'effect';
import { encode_wire } from '@norbital-ai/store/wire';
import { equal_json } from '@norbital-ai/store/kind';
import { argument_list, catalog_for, exposure_of, default_fields, type Catalog, type Pred, type SelectIR } from '@norbital-ai/store';
import type { ReadIR } from '../../protocol/reads.ts';
import { BoltError, from_store } from '../../protocol/errors.ts';
import type { Json } from '../../decl/values.ts';
import { LIMITS, type Authority, type Bindings, type Captured, type RowData } from '../contracts.ts';
import type { EngineManifest } from '../manifest.ts';
import { canRead, evaluate, type EvalEnv } from './eval.ts';
import { readPredicates } from '../access/authority.ts';
import { readTargets, sortTargets } from './engine.ts';
import { jsonbOrder } from '../db/wire.ts';
import { instantOrder, storedField, storedOrder } from '../db/stored.ts';
import { syncs_of } from '../sync/index.ts';
import { approvable } from '../approvals/lock.ts';
import { conversationRow, ConversationListRow, CONVERSATIONS, isStaff, listed, Message, transcriptRow } from '../agent/schema.ts';
import { INBOX_LIMIT, noticeRow, StoredNotice } from '../notifications/rows.ts';
import { RunViewRow, listedRun } from '../runs/rows.ts';

export type ViewRow = { readonly [field: string]: Json };
export const same = (a: Json | undefined, b: Json | undefined): boolean =>
	a === undefined || b === undefined ? a === b : equal_json(encode_wire(a), encode_wire(b));
const rowOf = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json));
const rowsOf = Schema.decodeUnknownOption(Schema.Struct({ rows: Schema.Array(Schema.Record(Schema.String, Schema.Json)) }));
const first = (value: Json): ViewRow | null | undefined => {
	const page = rowsOf(value);
	if (Option.isNone(page) || page.value.rows.length > 1) return undefined;
	const row = page.value.rows[0];
	return row === undefined ? null : typeof row['id'] === 'string' ? row : undefined;
};
const approvalRows = (capture: Captured, model: string): readonly string[] | 'all' => {
	const ids = new Set<string>();
	for (const image of [capture.old, capture.new]) {
		if (image === null || (image['state'] !== 'Pending' && image['state'] !== 'ChangesRequested')) continue;
		const records = image['records'];
		if (!Array.isArray(records)) return 'all';
		for (const record of records) {
			if (!Predicate.isObject(record) || typeof record['collection'] !== 'string' || typeof record['id'] !== 'string') return 'all';
			if (record['collection'] === model) ids.add(record['id']);
		}
	}
	return [...ids];
};
export type RowFetch = { readonly read: ReadIR; readonly row: (answer: Json) => ViewRow | null | undefined };
type Counter = { readonly key: string; readonly includes: (row: RowData, bindings: Bindings) => boolean | undefined };
export type Metadata = {
	readonly model: string;
	readonly id: string;
	readonly keys: readonly string[];
	readonly project: (row: RowData) => ViewRow;
};
type Common = { readonly source: ReadIR; readonly key: string; readonly models: ReadonlySet<string> };
type Rows = {
	readonly model: string;
	readonly matches: (row: RowData, bindings: Bindings) => boolean | undefined;
	readonly project: (row: RowData, bindings: Bindings, retained?: ViewRow) => ViewRow | null | undefined;
	readonly fetch?: (id: string) => RowFetch;
	readonly invalidates?: (capture: Captured) => boolean;
	readonly related?: (capture: Captured, value: Json) => readonly string[] | 'all';
};
export type GetView = Common & Rows & { readonly kind: 'get'; readonly id: string };
export type ReadView = Common & Rows & {
	readonly kind: 'read';
	readonly limit: number;
	readonly bounded: boolean;
	readonly place: (rows: readonly ViewRow[], row: ViewRow) => number | undefined;
	readonly kept: (before: ViewRow, after: ViewRow, capture: Captured) => boolean;
	readonly counters: readonly Counter[];
	readonly metadata: readonly Metadata[];
	readonly arrivals?: (row: RowData) => ViewRow | undefined;
};
type RequestView = Common & {
	readonly kind: 'request';
	readonly target?: { readonly model: string; readonly id: string };
	/** Undefined for an opaque query; composed requests retain and update each named root. */
	readonly roots?: readonly { readonly key: string; readonly plan: ViewPlan }[];
};
export type ViewPlan = GetView | ReadView | RequestView;
export function sourceKeys(read: ReadIR): readonly string[] {
	return [JSON.stringify(read), ...(read.kind === 'request'
		? read.roots.flatMap((root) => ('read' in root ? [root.read] : root.as_of).flatMap(sourceKeys)) : [])];
}

const utf8 = new TextEncoder();
const textOrder = (left: string, right: string): number => {
	const a = utf8.encode(left), b = utf8.encode(right);
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		const delta = (a[i] ?? 0) - (b[i] ?? 0);
		if (delta !== 0) return delta;
	}
	return a.length - b.length;
};
const newest = (field: string): ReadView['place'] => (rows, row) => {
	const at = instantOrder(row[field]), id = row['id'];
	if (at === undefined || typeof id !== 'string') return undefined;
	for (const [index, other] of rows.entries()) {
		const time = instantOrder(other[field]), otherId = other['id'];
		if (time === undefined || typeof otherId !== 'string') return undefined;
		if (time < at || (time === at && textOrder(otherId, id) < 0)) return index;
	}
	return rows.length;
};
function decidable(cat: Catalog, model: string, p: Pred): boolean {
	switch (p.t) {
		case 'and': case 'or': return p.of.every((part) => decidable(cat, model, part));
		case 'not': return decidable(cat, model, p.of);
		case 'one': case 'many': case 'count': case 'agg': case 'geo': case 'period':
		case 'path': case 'each': case 'search': case 'similar': return false;
		case 'const': return true;
		case 'cmp':
			if (p.op !== 'eq' && p.op !== 'ne' && cat.models.get(model)?.fields.get(p.field)?.pg === 'text') return false;
			return !p.field.includes('.') && !(p.arg._tag === 'Field' && p.arg.field.includes('.'));
		case 'in': return !p.field.includes('.') && (argument_list(p.args) || p.args._tag !== 'Member');
		default: return !p.field.includes('.');
	}
}

export class ViewCompiler {
	private readonly cat: Catalog;
	private readonly manifest: EngineManifest;
	constructor(cat: Catalog, manifest: EngineManifest) {
		this.cat = cat;
		this.manifest = manifest;
	}
	compile(read: ReadIR, authority: Authority): Effect.Effect<ViewPlan, BoltError> {
		return Effect.gen(function* (this: ViewCompiler): Effect.fn.Return<ViewPlan, BoltError> {
		const common = { source: read, key: JSON.stringify(read), models: readTargets(this.cat, read, authority) };
		const opaque = (): RequestView => ({ ...common, kind: 'request' });
		const page = (rows: Rows, limit: number, field: string): ReadView => ({
			...common, ...rows, kind: 'read', limit, bounded: true, counters: [], metadata: [],
			place: newest(field), kept: (before, after) => same(before[field], after[field])
		});
		switch (read.kind) {
			case 'request': {
				const roots: { key: string; plan: ViewPlan }[] = [];
				for (const root of read.roots) roots.push({ key: root.root,
				plan: 'read' in root ? yield* this.compile(root.read, authority) : {
					kind: 'request', source: { kind: 'request', roots: [root] }, key: JSON.stringify(root),
					models: new Set(root.as_of.flatMap((ir) => [...readTargets(this.cat, ir, authority)]))
				} });
				return { ...common, kind: 'request', roots, models: new Set(roots.flatMap((root) => [...root.plan.models])) };
			}
			case 'after': return yield* BoltError.make('invalid', 'decode', 'an after read is not liveable');
			case 'history': return { ...opaque(), target: { model: read.model, id: read.id } };
			case 'aggregate': case 'similar': return opaque();
			case 'transcript': return { ...page({
				model: read.model,
				matches: (row) => row['conversation'] === read.conversation && (read.from === undefined || Number(row['seq']) >= read.from),
				project: (row) => {
					const value = Schema.decodeUnknownOption(Message)(row);
					return Option.isNone(value) ? undefined : transcriptRow(value.value, isStaff(authority), read.thread);
				}
			}, LIMITS.page.all, 'seq'), bounded: false,
				place: (rows, row) => {
					const seq = row['seq'];
					if (typeof seq !== 'number') return undefined;
					const at = rows.findIndex((other) => typeof other['seq'] === 'number' && other['seq'] > seq);
					return at < 0 ? rows.length : at;
				},
				metadata: [{ model: 'sys_conversation', id: read.conversation, keys: ['status', 'inputs', 'outputs'], project: (row) => {
					const value: { [key: string]: Json } = {}, status = row['status'];
					if (status === 'idle' || status === 'running' || status === 'stopped') value['status'] = status;
					for (const key of ['inputs', 'outputs']) {
						const refs = row[key];
						if (Array.isArray(refs) && refs.length > 0) value[key] = refs;
					}
					return value;
				} }] };
			case 'inbox': {
				const project = (row: RowData) => Option.map(Schema.decodeUnknownOption(StoredNotice)(row), noticeRow);
				return { ...page({ model: read.model,
				matches: (row) => row['member'] === read.member,
				project: (row) => Option.getOrUndefined(project(row))
			}, INBOX_LIMIT, 'at'), counters: [{ key: 'unread', includes: (row) => row['member'] === read.member && row['read_at'] == null }],
				arrivals: (row) => row['member'] === read.member ? Option.getOrUndefined(project(row)) : undefined };
			}
			case 'conversations': return { ...page({ model: read.model,
				matches: (row) => read.id !== undefined && row['id'] !== read.id ? false : listed(row, read.member, authority.admin) ? true :
					(row['parent'] ?? null) === null && (row['integration'] ?? null) !== null ? undefined : false,
				project: (row) => {
					if (row['integration'] != null && row['kind'] === 'dm' && row['peer'] === undefined) return undefined;
					return Option.getOrUndefined(Option.map(Schema.decodeUnknownOption(ConversationListRow)(row), conversationRow));
				},
				fetch: (id) => ({ read: { ...read, id }, row: first })
			}, CONVERSATIONS, 'at'), related: (capture) => {
				if (capture.model !== 'sys_message') return 'all';
				return [...new Set([capture.old?.['conversation'], capture.new?.['conversation']].filter((id): id is string => typeof id === 'string'))];
			} };
			case 'runs': return { ...page({ model: read.model,
				matches: (row) => authority.actor.kind === 'member' &&
					(read.id === undefined || row['id'] === read.id) && (read.automation === undefined || row['automation'] === read.automation),
				project: (image) => {
					const row = Schema.decodeUnknownOption(RunViewRow)(image);
					if (Option.isNone(row)) return undefined;
					const shown = listedRun(authority, row.value, read.brief);
					if (shown === null) return null;
					return Option.getOrUndefined(rowOf(encode_wire(shown)));
				}, fetch: (id) => ({ read: { ...read, id, limit: 1 }, row: first })
			}, Math.min(Math.max(1, read.limit), 500), 'due_at'), related: (capture, value) => {
				if (capture.model !== 'sys_user') return 'all';
				const page = rowsOf(value);
				if (Option.isNone(page)) return 'all';
				return page.value.rows.flatMap((row) => Predicate.isObject(row['trigger']) && row['trigger']['ref'] === `member:${capture.id}` && typeof row['id'] === 'string' ? [row['id']] : []);
			} };
			case 'get': case 'read': {
				if (read.kind === 'read' && read.page._tag === 'Limit' && read.page.after !== undefined)
					return yield* BoltError.make('invalid', 'decode', 'a cursor page read is not liveable');
				const { cat } = this, model = read.model, output = read.output;
				const predicates = readPredicates(authority, model, output ?? 'default');
				const where = read.kind === 'get' ? undefined : read.where;
				const unknown = (where !== undefined && !decidable(cat, model, where)) || predicates?.some((where) => !decidable(cat, model, where));
				const matches: Rows['matches'] = (raw, bindings) => {
					if (read.kind === 'get' && raw['id'] !== read.id) return false;
					if (unknown) return undefined;
					const row = raw, env: EvalEnv = { cat, bindings, authority, scoped: true };
					return canRead(env, model, row, output ?? 'default') && (where === undefined || evaluate(env, model, where, row));
				};
				const projected = yield* catalog_for(cat, model, output).pipe(
					Effect.flatMap((view) => exposure_of(view, model)),
					Effect.mapError(from_store)
				);
				const fields = read.select.fields ?? default_fields(projected, read.kind === 'get');
				const syncs = [...syncs_of(this.manifest).values()].filter((sync) => sync.model === model && sync.write);
				const models = new Set([...common.models, 'bolt_approvals', 'sys_user', ...(syncs.length > 0 ? ['sys_outbox'] : [])]);
				const dependencies: Rows['related'] = (capture) => {
					if (capture.model === 'bolt_approvals') return approvalRows(capture, model);
					if (capture.model === 'sys_outbox') {
						const ids = new Set<string>();
						for (const image of [capture.old, capture.new]) {
							if (image === null || image['model'] !== model) continue;
							const id = image['record'];
							if (typeof id !== 'string') return 'all';
							ids.add(id);
						}
						return [...ids];
					}
					if (capture.model === 'sys_user' && !common.models.has('sys_user') &&
						same(capture.old?.['name'], capture.new?.['name']) && same(capture.old?.['email'], capture.new?.['email'])) return [];
					return 'all';
				};
				const related = Object.keys(read.select.relations).length > 0 || cat.models.get(model)?.label_link !== undefined ||
					projected.model.record_label?.stored === false ||
					syncs.length > 0 || approvable(this.manifest, cat).has(model);
				const project: Rows['project'] = (raw, _bindings, retained) => {
					if (related || retained?.['$approval'] !== undefined || (read.kind === 'read' && read.search !== undefined)) return undefined;
					const row = raw, id = row['id'];
					if (typeof id !== 'string') return undefined;
					const out: { [key: string]: Json } = { id };
					for (const name of fields) {
						if (name === 'id') continue;
						const field = projected.model.fields.get(name);
						if (field === undefined || name.includes('.')) return undefined;
						// a numeric JSON number has lost its scale (`storedCaptures`): the row is fetched
						if (field.pg === 'numeric' && typeof row[field.column] === 'number') return undefined;
						const value = storedField(field, row);
						if (value === undefined) return undefined;
						out[name] = value;
					}
					return jsonbOrder(out);
				};
				if (read.kind === 'get') return { ...common, models, kind: 'get', model, id: read.id, matches, project, related: dependencies };
				const { total, ...source } = read;
				const order = [...(read.order ?? []), { field: 'id', dir: 'asc' as const }];
				const place: ReadView['place'] = (rows, row) => {
					for (const [index, other] of rows.entries()) {
						for (const key of order) {
							if ('near' in key && key.near !== undefined) return undefined;
							const field = projected.model.fields.get(key.field), a = row[key.field], b = other[key.field];
							if (field === undefined || a === undefined || b === undefined) return undefined;
							if (a === null && b === null) continue;
							if (a === null || b === null) { if ((a === null) === (key.dir === 'desc')) return index; break; }
							if (field.pg === 'text' && a !== b) return undefined;
							const delta = storedOrder(field, a, b);
							if (delta === undefined || (delta === 0 && field.pg === 'timestamptz')) return undefined;
							if (delta === 0) continue;
							if ((delta < 0) === (key.dir === 'asc')) return index;
							break;
						}
					}
					return rows.length;
				};
				const select: SelectIR = { fields, relations: read.select.relations };
				return { ...common, models, kind: 'read', model, matches, project, related: dependencies, limit: read.page._tag === 'Limit' ? read.page.limit : LIMITS.page.all,
					bounded: false, counters: total ? [{ key: 'total', includes: matches }] : [], metadata: [], place,
					kept: (_before, _after, capture) => capture.old !== null && capture.new !== null && order.every(({ field }) => {
						const head = field.split('.')[0];
						if (head === undefined) return false;
						const column = projected.model.fields.get(head)?.column ?? head;
						return same(capture.old?.[column], capture.new?.[column]);
					}),
					fetch: (id) => ({ read: { ...source, select, page: { _tag: 'Limit', limit: 1 },
						where: { t: 'and', of: [...(read.where === undefined ? [] : [read.where]), { t: 'cmp', field: 'id', op: 'eq', arg: { _tag: 'Lit', value: id } }] } }, row: first }),
					invalidates: (capture) => sortTargets(cat, model, read.order).has(capture.model)
				};
			}
		}
		}.bind(this));
	}
}
