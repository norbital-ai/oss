// A bulk create is one statement: its row rules cost one check per statement, not one dynamic query per row and parent.
import type { PGlite } from '@electric-sql/pglite';
import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { build, schema, table } from '../src/index.ts';
import { database, script } from './support.ts';

const declaration = schema({
	parent: table({
		audit: true,
		key: 'text',
		fields: {
			status: { kind: 'state', initial: 'open', states: { open: { to: ['closed'] }, closed: {} } }
		},
		locks: {
			open: { where: { status: { eq: 'open' } }, except: ['status', 'children'] },
			closed: { where: { status: { eq: 'closed' } } }
		}
	}),
	child: table({
		audit: true,
		key: 'text',
		fields: {
			parent: { kind: 'ref', to: 'parent', owned: true, inverse: 'children' },
			note: { kind: 'text' }
		},
		locks: { sealed: { where: { note: { eq: 'sealed' } } } }
	})
});

const WRITE = `select set_config('store.write','{"mode":"write","actor":"bulk","at":null}',true)`;
const bulk = (pg: PGlite, n: number, parent: string, from = 0) =>
	Effect.promise(async () => {
		const started = performance.now();
		await pg.exec(`begin; ${WRITE};
			insert into child(id,parent,note,revision)
				select 'c' || (g + ${from}), '${parent}', 'n' || g, 1 from generate_series(1, ${n}) g;
			commit;`);
		return performance.now() - started;
	});
const refused = (pg: PGlite, text: string) =>
	Effect.promise(() =>
		pg.exec(`begin; ${WRITE}; ${text}; commit;`).then(
			() => 'accepted',
			async (e: unknown) => {
				await pg.exec('rollback');
				return e instanceof Error ? e.message : String(e);
			}
		)
	);

it.live('bulk create checks row rules once per statement and keeps every lock', () =>
	Effect.gen(function* () {
		const pg = yield* database;
		yield* script(pg, (yield* build(declaration)).join(';\n'));
		yield* script(pg, `begin; ${WRITE}; insert into parent(id,revision) values ('open',1), ('shut',1); commit;`);
		const thousand = yield* bulk(pg, 1_000, 'open');
		const tenThousand = yield* bulk(pg, 10_000, 'open', 1_000);
		console.info(`bulk create on PGlite: 1,000 rows ${thousand.toFixed(0)} ms; 10,000 rows ${tenThousand.toFixed(0)} ms`);
		expect(yield* Effect.promise(() => pg.query('select count(*)::int as n from child'))).toMatchObject({
			rows: [{ n: 11_000 }]
		});

		// a closed parent refuses a bulk of new children, an edit and a removal, whatever the batch size
		yield* script(pg, `begin; ${WRITE}; update parent set status='closed' where id='shut'; commit;`);
		expect(yield* refused(pg, `insert into child(id,parent,note,revision) select 'x'||g,'shut','x',1 from generate_series(1,50) g`)).toMatch(
			/relation children is locked by closed/
		);
		yield* script(pg, `begin; select set_config('store.write','{"mode":"seed","actor":"seed","at":null}',true);
			insert into child(id,parent,note,revision) values ('kept','shut','kept',1), ('sealed','open','sealed',1); commit;`);
		expect(yield* refused(pg, `update child set note='edit' where id='kept'`)).toMatch(/relation children is locked by closed/);
		expect(yield* refused(pg, `delete from child where id='kept'`)).toMatch(/relation children is locked by closed/);
		// a row's own lock: its fields are frozen and it cannot be removed, in a bulk statement or alone
		expect(yield* refused(pg, `update child set note='edit' where parent='open'`)).toMatch(/note is locked by sealed/);
		expect(yield* refused(pg, `delete from child where parent='open'`)).toMatch(/record is locked by sealed/);
		// the open lock exempts children: the parent's own children may change while it is open
		expect(yield* refused(pg, `update child set note='edited' where id='c1'`)).toBe('accepted');
	})
);
