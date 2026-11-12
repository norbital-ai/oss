import { describe, expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import {
	build,
	compile_write,
	constraint_index,
	schema,
	store,
	table,
	type Sql
} from '../src/index.ts';
import { database, required, run, script } from './support.ts';

const declaration = schema({
	ticket: table({
		audit: true,
		natural: ['code'],
		fields: {
			code: { kind: 'text' },
			title: { kind: 'text' },
			note: { kind: 'text', optional: true },
			checked_at: { kind: 'instant', optional: true },
			labels: { kind: 'text', many: true, default: [] },
			status: {
				kind: 'state',
				initial: 'draft',
				states: {
					draft: { to: ['review'] },
					review: { to: ['draft', 'done'] },
					done: {}
				}
			}
		},
		locks: {
			review: { where: { status: { eq: 'review' } }, except: ['status', 'note'] },
			done: { where: { status: { eq: 'done' } } }
		}
	})
});
const db = store(declaration);
const fresh = Effect.gen(function* () {
	const pg = yield* database;
	yield* script(pg, `${(yield* build(declaration)).join(';\n')};`);
	return { pg, execute: run(pg) };
});
const locked = Effect.fnUntraced(function* (
	pg: Effect.Success<typeof database>,
	statement: Sql,
	column: string,
	rule: 'review' | 'done'
) {
	const error = yield* Effect.flip(
		Effect.tryPromise({
			try: () =>
				pg.query(
					statement.text,
					statement.params.map((value) =>
						value !== null && typeof value === 'object' ? JSON.stringify(value) : value
					)
				),
			catch: (cause: unknown) => cause
		})
	);
	const native = yield* Schema.decodeUnknownEffect(
		Schema.Struct({ code: Schema.String, column: Schema.String, constraint: Schema.String })
	)(error);
	expect(native).toMatchObject({ code: '23514', column });
	expect((yield* constraint_index(declaration)).get(native.constraint)).toMatchObject({
		model: 'ticket',
		kind: 'locked',
		fields: [],
		rule
	});
});

describe('standalone state rules', () => {
	it.effect(
		'defaults every create to its initial state and refuses noninitial creates before emitting SQL',
		() =>
			Effect.gen(function* () {
				const { execute } = yield* fresh;
				const created = yield* execute(
					yield* db.create('ticket', [
						{ code: 'A', title: 'A' },
						{ code: 'B', title: 'B' }
					])
				);
				expect(created.map((row) => row.status)).toEqual(['draft', 'draft']);
				const refusal = yield* Effect.flip(
					compile_write(db.catalog, {
						kind: 'create',
						table: 'ticket',
						rows: [
							{ code: 'C', title: 'C' },
							{ code: 'D', title: 'D', status: 'done' }
						],
						select: { fields: null, relations: {} }
					})
				);
				expect(refusal).toMatchObject({ code: 'invalid_input', phase: 'admission' });
				expect(refusal.message).toContain("'status' = 'draft'");
				expect((yield* execute(yield* db.read('ticket', { all: true }))).rows).toHaveLength(2);
			})
	);

	it.effect('refuses an entire mixed batch when one state transition is undeclared', () =>
		Effect.gen(function* () {
			const { execute } = yield* fresh;
			const rows = yield* execute(
				yield* db.create('ticket', [
					{ code: 'A', title: 'A' },
					{ code: 'B', title: 'B' }
				])
			);
			const closed = required(rows.find((row) => row.code === 'B'));
			yield* execute(
				yield* db.update('ticket', { key: { id: closed.id }, set: { status: 'review' } })
			);
			yield* execute(
				yield* db.update('ticket', { key: { id: closed.id }, set: { status: 'done' } })
			);
			const refusal = yield* Effect.flip(
				execute(
					yield* db.update('ticket', {
						where: {},
						set: { status: 'review' }
					})
				)
			);
			expect(refusal).toMatchObject({ code: 'invalid_input', phase: 'admission' });
			expect(
				(yield* execute(yield* db.read('ticket', { order_by: 'code', all: true }))).rows.map(
					(row) => [row.code, row.status, row.revision]
				)
			).toEqual([
				['A', 'draft', 1],
				['B', 'done', 3]
			]);
		})
	);

	it.effect(
		'enforces predicate locks and atomic edits against the stored row, while permitting unchanged values',
		() =>
			Effect.gen(function* () {
				const { pg, execute } = yield* fresh;
				const row = required(
					(yield* execute(yield* db.create('ticket', { code: 'A', title: 'A' })))[0]
				);
				yield* execute(
					yield* db.update('ticket', { key: { id: row.id }, set: { status: 'review' } })
				);
				yield* locked(
					pg,
					(yield* db.update('ticket', {
						key: { id: row.id },
						set: { title: 'blocked', note: 'also rolled back' }
					})).sql,
					'title',
					'review'
				);
				yield* locked(
					pg,
					(yield* db.update('ticket', {
						key: { id: row.id },
						set: { labels: { $append: ['blocked'] } }
					})).sql,
					'labels',
					'review'
				);
				yield* locked(
					pg,
					(yield* db.update('ticket', {
						key: { id: row.id },
						set: { note: 'also rolled back' },
						now: ['checked_at']
					})).sql,
					'checked_at',
					'review'
				);
				expect(yield* execute(yield* db.get('ticket', { id: row.id }))).toMatchObject({
					title: 'A',
					note: null,
					labels: [],
					checked_at: null,
					status: 'review',
					revision: 2
				});
				const managed = yield* Effect.flip(
					compile_write(db.catalog, {
						kind: 'update',
						table: 'ticket',
						where: { t: 'const', value: true },
						set: {},
						now: ['updated_at'],
						select: { fields: null, relations: {} }
					})
				);
				expect(managed.code).toBe('invalid');
				const changed = required(
					(yield* execute(
						yield* db.update('ticket', {
							key: { id: row.id },
							set: { status: 'review', title: 'A', labels: { $append: [] }, note: 'allowed' }
						})
					))[0]
				);
				expect(changed).toMatchObject({
					title: 'A',
					labels: [],
					note: 'allowed',
					checked_at: null,
					status: 'review',
					revision: 3
				});
				yield* execute(
					yield* db.update('ticket', { key: { id: row.id }, set: { status: 'done' } })
				);
				yield* locked(
					pg,
					(yield* db.update('ticket', { key: { id: row.id }, set: { note: 'blocked' } })).sql,
					'note',
					'done'
				);
				expect(yield* execute(yield* db.get('ticket', { id: row.id }))).toMatchObject({
					title: 'A',
					note: 'allowed',
					labels: [],
					checked_at: null,
					status: 'done',
					revision: 4
				});
			})
	);

	it.effect('does not partly update a stateful batch when one observed revision moved', () =>
		Effect.gen(function* () {
			const { execute } = yield* fresh;
			const rows = yield* execute(
				yield* db.create('ticket', [
					{ code: 'A', title: 'A' },
					{ code: 'B', title: 'B' }
				])
			);
			const changed = required(rows.find((row) => row.code === 'B'));
			yield* execute(
				yield* db.update('ticket', { key: { id: changed.id }, set: { note: 'newer' }, observed: 1 })
			);
			const stale = yield* Effect.flip(
				execute(
					yield* db.update('ticket', {
						where: {},
						set: { title: 'lost' },
						now: ['checked_at'],
						observed: 1
					})
				)
			);
			expect(stale.code).toBe('stale');
			expect(
				(yield* execute(yield* db.read('ticket', { order_by: 'code', all: true }))).rows.map(
					(row) => [row.title, row.note, row.revision, row.checked_at]
				)
			).toEqual([
				['A', null, 1, null],
				['B', 'newer', 2, null]
			]);
		})
	);

	it.effect('refuses mutating stateful upserts and permits validated keep-only inserts', () =>
		Effect.gen(function* () {
			const { execute } = yield* fresh;
			yield* execute(yield* db.create('ticket', { code: 'A', title: 'A' }));
			const unsupported = yield* Effect.flip(
				db.upsert(
					'ticket',
					[
						{ code: 'A', title: 'blocked' },
						{ code: 'B', title: 'must not insert' }
					],
					{ on: ['code'] }
				)
			);
			expect(unsupported).toMatchObject({ code: 'invalid_input', phase: 'admission' });
			expect(unsupported.message).toContain("update: 'keep'");
			const clock = yield* Effect.flip(
				db.upsert(
					'ticket',
					{ code: 'A', title: 'blocked' },
					{ on: ['code'], update: 'keep', now: ['checked_at'] }
				)
			);
			expect(clock).toMatchObject({ code: 'invalid_input', phase: 'admission' });
			const initial = yield* Effect.flip(
				db.upsert(
					'ticket',
					[
						{ code: 'C', title: 'C' },
						{ code: 'D', title: 'D', status: 'done' }
					],
					{ on: ['code'], update: 'keep', actor: 'writer', when: { status: { eq: 'draft' } } }
				)
			);
			expect(initial).toMatchObject({ code: 'invalid_input', phase: 'admission' });
			yield* execute(
				yield* db.upsert(
					'ticket',
					[
						{ code: 'A', title: 'ignored' },
						{ code: 'B', title: 'B' }
					],
					{ on: ['code'], update: 'keep' }
				)
			);
			expect(
				(yield* execute(yield* db.read('ticket', { order_by: 'code', all: true }))).rows.map(
					(row) => [row.code, row.title, row.status]
				)
			).toEqual([
				['A', 'A', 'draft'],
				['B', 'B', 'draft']
			]);
		})
	);
});
