// These writes bypass Store's compiler: the declared schema itself owns the row invariants.
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { build, schema, table } from '../src/index.ts';
import { exec, script } from './support.ts';

const database = Effect.acquireRelease(
	Effect.promise(() => PGlite.create({ extensions: { btree_gist } })),
	(pg) => Effect.promise(() => pg.close())
);
const query = (pg: PGlite, text: string) => exec(pg)({ text, params: [] });
const rejected = Effect.fnUntraced(function* (pg: PGlite, text: string, code: string) {
	const error = yield* Effect.flip(
		Effect.tryPromise({
			try: () => pg.query(text),
			catch: (cause: unknown) => cause
		})
	);
	const native = yield* Schema.decodeUnknownEffect(
		Schema.Struct({
			code: Schema.String,
			message: Schema.String
		})
	)(error);
	expect(native.code).toBe(code);
	return native;
});

it.effect(
	'raw SQL preserves primary keys, required fields, enums, uniqueness and authored checks',
	() =>
		Effect.gen(function* () {
			const declaration = schema({
				entry: table({
					key: 'text',
					fields: {
						code: { kind: 'text', unique: true },
						title: { kind: 'text' },
						status: { kind: 'enum', values: ['open', 'closed'], default: 'open' },
						optional: { kind: 'text', optional: true },
						amount: { kind: 'int', min: 0, max: 100 }
					},
					check: { positive: { where: { amount: { gt: 0 } }, message: 'amount must be positive' } }
				})
			});
			const pg = yield* database;
			yield* script(pg, (yield* build(declaration)).join(';\n'));
			yield* script(pg, "INSERT INTO entry (id,code,title,amount) VALUES ('one','A','One',1)");
			expect(yield* query(pg, 'SELECT status,optional FROM entry')).toEqual([
				{ status: 'open', optional: null }
			]);
			for (const [text, code] of [
				["INSERT INTO entry (id,code,title,amount) VALUES ('one','B','Duplicate key',1)", '23505'],
				["INSERT INTO entry (id,code,title,amount) VALUES ('two','A','Duplicate code',1)", '23505'],
				["INSERT INTO entry (id,code,amount) VALUES ('two','B',1)", '23502'],
				[
					"INSERT INTO entry (id,code,title,status,amount) VALUES ('two','B','Null',NULL,1)",
					'23502'
				],
				["UPDATE entry SET status='unknown' WHERE id='one'", '23514'],
				["UPDATE entry SET amount=101 WHERE id='one'", '23514'],
				["UPDATE entry SET amount=0 WHERE id='one'", '23514']
			] as const)
				yield* rejected(pg, text, code);
			expect(yield* query(pg, 'SELECT id,code,title,status,amount FROM entry')).toEqual([
				{ id: 'one', code: 'A', title: 'One', status: 'open', amount: 1 }
			]);
		})
);

it.effect(
	'raw refs enforce each physical target, polymorphic exclusivity and declared one-to-one uniqueness',
	() =>
		Effect.gen(function* () {
			const declaration = schema({
				person: table({ key: 'text', fields: { name: { kind: 'text' } } }),
				company: table({ key: 'text', fields: { name: { kind: 'text' } } }),
				profile: table({
					key: 'text',
					fields: { person: { kind: 'ref', to: 'person', unique: true } }
				}),
				note: table({ key: 'text', fields: { about: { kind: 'ref', to: ['person', 'company'] } } }),
				optional_note: table({
					key: 'text',
					fields: { about: { kind: 'ref', to: ['person', 'company'], optional: true } }
				})
			});
			const pg = yield* database;
			yield* script(pg, (yield* build(declaration)).join(';\n'));
			yield* script(
				pg,
				`
			INSERT INTO person (id,name) VALUES ('p','Person');
			INSERT INTO company (id,name) VALUES ('c','Company');
			INSERT INTO profile (id,person) VALUES ('profile','p');
			INSERT INTO note (id,about__person) VALUES ('person-note','p');
			INSERT INTO note (id,about__company) VALUES ('company-note','c');
			INSERT INTO optional_note (id) VALUES ('empty');
		`
			);
			for (const [text, code] of [
				["INSERT INTO profile (id,person) VALUES ('duplicate','p')", '23505'],
				["INSERT INTO profile (id,person) VALUES ('missing','missing')", '23503'],
				["INSERT INTO profile (id) VALUES ('null')", '23502'],
				["INSERT INTO note (id) VALUES ('none')", '23514'],
				["INSERT INTO note (id,about__person,about__company) VALUES ('both','p','c')", '23514'],
				["INSERT INTO note (id,about__company) VALUES ('missing','missing')", '23503'],
				["UPDATE optional_note SET about__person='p',about__company='c' WHERE id='empty'", '23514']
			] as const)
				yield* rejected(pg, text, code);
			expect(
				yield* query(pg, 'SELECT id,about__person,about__company FROM note ORDER BY id')
			).toEqual([
				{ id: 'company-note', about__person: null, about__company: 'c' },
				{ id: 'person-note', about__person: 'p', about__company: null }
			]);
		})
);

it.effect(
	'natural keys are never null and composite primary-key fields keep their declared bounds',
	() =>
		Effect.gen(function* () {
			const declaration = schema({
				natural_key: table({
					key: 'text',
					natural: ['code'],
					fields: { code: { kind: 'text', optional: true } }
				}),
				composite_key: table({
					key: ['scope', 'number'],
					fields: {
						scope: { kind: 'enum', values: ['a', 'b'] },
						number: { kind: 'int', min: 1, max: 9, default: 3 },
						note: { kind: 'text', optional: true }
					}
				})
			});
			const pg = yield* database;
			yield* script(pg, (yield* build(declaration)).join(';\n'));
			yield* rejected(pg, "INSERT INTO natural_key (id) VALUES ('null')", '23502');
			yield* script(pg, "INSERT INTO natural_key (id,code) VALUES ('one','A')");
			yield* rejected(pg, "INSERT INTO natural_key (id,code) VALUES ('two','A')", '23505');
			yield* script(pg, "INSERT INTO composite_key (scope) VALUES ('a')");
			for (const text of [
				"INSERT INTO composite_key (scope,number) VALUES ('a',0)",
				"INSERT INTO composite_key (scope,number) VALUES ('a',10)",
				"INSERT INTO composite_key (scope,number) VALUES ('unknown',1)",
				"UPDATE composite_key SET number=4 WHERE scope='a' AND number=3",
				"UPDATE composite_key SET scope='b' WHERE scope='a' AND number=3"
			])
				yield* rejected(pg, text, '23514');
			yield* script(
				pg,
				"UPDATE composite_key SET scope='a',number=3,note='allowed' WHERE scope='a'"
			);
			expect(yield* query(pg, 'SELECT scope,number,note FROM composite_key')).toEqual([
				{ scope: 'a', number: 3, note: 'allowed' }
			]);
		})
);

it.effect('raw partial uniqueness and range exclusion retain their native atomic constraints', () =>
	Effect.gen(function* () {
		const declaration = schema({
			entry: table({
				key: 'text',
				fields: {
					code: { kind: 'text' },
					active: { kind: 'bool' }
				},
				unique: [{ fields: ['code'], where: { active: { eq: true } } }]
			}),
			booking: table({
				key: 'text',
				fields: {
					room: { kind: 'text' },
					during: { kind: 'period', of: 'date' }
				},
				noOverlap: [{ key: ['room'], period: 'during' }]
			})
		});
		const pg = yield* database;
		yield* script(pg, (yield* build(declaration)).join(';\n'));
		yield* script(
			pg,
			`
			INSERT INTO entry (id,code,active) VALUES ('active','A',true),('inactive','A',false);
			INSERT INTO booking (id,room,during) VALUES ('first','A','[2026-10-01,2026-10-05)'::daterange);
		`
		);
		yield* rejected(
			pg,
			"INSERT INTO entry (id,code,active) VALUES ('duplicate','A',true)",
			'23505'
		);
		yield* rejected(pg, "UPDATE entry SET active=true WHERE id='inactive'", '23505');
		yield* rejected(
			pg,
			"INSERT INTO booking (id,room,during) VALUES ('overlap','A','[2026-10-03,2026-10-06)'::daterange)",
			'23P01'
		);
		yield* script(
			pg,
			"INSERT INTO booking (id,room,during) VALUES ('adjacent','A','[2026-10-05,2026-10-08)'::daterange)"
		);
		expect(yield* query(pg, 'SELECT count(*)::int AS n FROM booking')).toEqual([{ n: 2 }]);
	})
);

const stateDeclaration = schema({
	person: table({ key: 'text', fields: { name: { kind: 'text' } } }),
	company: table({ key: 'text', fields: { name: { kind: 'text' } } }),
	ticket: table({
		key: 'text',
		audit: true,
		managedDeletes: true,
		fields: {
			title: { kind: 'text' },
			note: { kind: 'text', optional: true },
			none: { kind: 'text', optional: true },
			labels: { kind: 'list', of: { kind: 'text' }, default: [] },
			party: { kind: 'ref', to: ['person', 'company'], optional: true },
			status: {
				kind: 'state',
				initial: 'draft',
				states: {
					draft: { to: ['review'] },
					review: { to: ['draft', 'done'], edit: ['note'] },
					done: { edit: 'none' }
				}
			}
		},
		computed: { shout: { kind: 'text', expr: { upper: { field: 'title' } } } }
	})
});

it.effect('raw owned-child and through-link writes respect the locked parent state', () =>
	Effect.gen(function* () {
		const declaration = schema({
			parent: table({
				key: 'text',
				fields: {
					status: {
						kind: 'state',
						initial: 'open',
						states: {
							open: { to: ['closed'], edit: ['children', 'tags'] },
							closed: { edit: 'none' }
						}
					}
				},
				through: { tags: { table: 'link', from: 'parent', to: 'tag' } }
			}),
			child: table({
				key: 'text',
				fields: {
					parent: { kind: 'ref', to: 'parent', owned: true, inverse: 'children' },
					note: { kind: 'text' }
				}
			}),
			tag: table({ key: 'text', fields: { name: { kind: 'text' } } }),
			link: table({
				key: 'text',
				fields: {
					parent: { kind: 'ref', to: 'parent', onDelete: 'cascade' },
					tag: { kind: 'ref', to: 'tag' }
				}
			})
		});
		const pg = yield* database;
		yield* script(pg, (yield* build(declaration)).join(';\n'));
		yield* script(
			pg,
			`INSERT INTO parent(id) VALUES ('parent');
			INSERT INTO child(id,parent,note) VALUES ('child','parent','old');
			INSERT INTO tag(id,name) VALUES ('tag','Tag');
			INSERT INTO link(id,parent,tag) VALUES ('link','parent','tag');
			UPDATE parent SET status='closed' WHERE id='parent'`
		);
		for (const text of [
			"UPDATE child SET note='blocked' WHERE id='child'",
			"INSERT INTO child(id,parent,note) VALUES ('new','parent','blocked')",
			"DELETE FROM child WHERE id='child'",
			"DELETE FROM link WHERE id='link'"
		])
			yield* rejected(pg, text, '23514');
		expect(yield* query(pg, 'SELECT note FROM child')).toEqual([{ note: 'old' }]);
		// Referential deletion is still owned by PostgreSQL; its absent parent cannot be edited by a child.
		yield* script(pg, "DELETE FROM parent WHERE id='parent'");
		expect(yield* query(pg, 'SELECT count(*)::int AS n FROM child')).toEqual([{ n: 0 }]);
		expect(yield* query(pg, 'SELECT count(*)::int AS n FROM link')).toEqual([{ n: 0 }]);
	})
);
const stateDatabase = Effect.gen(function* () {
	const pg = yield* database;
	yield* script(pg, (yield* build(stateDeclaration)).join(';\n'));
	yield* script(
		pg,
		`
		INSERT INTO person (id,name) VALUES ('p','Person');
		INSERT INTO company (id,name) VALUES ('c','Company');
		INSERT INTO ticket (id,title,party__person) VALUES ('ticket','Original','p');
	`
	);
	return pg;
});

it.effect(
	'raw INSERT begins at the initial state and UPDATE follows declared edges atomically',
	() =>
		Effect.gen(function* () {
			const pg = yield* stateDatabase;
			for (const status of ['review', 'done', 'unknown'])
				yield* rejected(
					pg,
					`INSERT INTO ticket (id,title,status) VALUES ('invalid','Invalid','${status}')`,
					'23514'
				);
			yield* rejected(
				pg,
				"INSERT INTO ticket (id,title,status) VALUES ('valid-part','Valid','draft'),('invalid-part','Invalid','done')",
				'23514'
			);
			expect(yield* query(pg, 'SELECT count(*)::int AS n FROM ticket')).toEqual([{ n: 1 }]);
			yield* rejected(pg, "UPDATE ticket SET status='done' WHERE id='ticket'", '23514');
			yield* script(pg, "UPDATE ticket SET status='review' WHERE id='ticket'");
			yield* script(pg, "UPDATE ticket SET status='done' WHERE id='ticket'");
			yield* rejected(pg, "UPDATE ticket SET status='draft' WHERE id='ticket'", '23514');
			yield* script(pg, "INSERT INTO ticket (id,title) VALUES ('second','Second')");
			yield* rejected(pg, "UPDATE ticket SET status='review'", '23514');
			expect(yield* query(pg, 'SELECT id,status,revision FROM ticket ORDER BY id')).toEqual([
				{ id: 'second', status: 'draft', revision: 1 },
				{ id: 'ticket', status: 'done', revision: 3 }
			]);
		})
);

it.effect(
	'state edit guards use OLD state and compare physical values, including polymorphic arms',
	() =>
		Effect.gen(function* () {
			const pg = yield* stateDatabase;
			yield* script(pg, "UPDATE ticket SET status='review' WHERE id='ticket'");
			for (const text of [
				"UPDATE ticket SET title='blocked',note='rolled back' WHERE id='ticket'",
				"UPDATE ticket SET status='draft',title='blocked' WHERE id='ticket'",
				"UPDATE ticket SET labels='[\"blocked\"]'::jsonb WHERE id='ticket'",
				"UPDATE ticket SET party__person=NULL,party__company='c' WHERE id='ticket'"
			])
				yield* rejected(pg, text, '23514');
			yield* script(
				pg,
				"UPDATE ticket SET title='Original',labels='[]'::jsonb,note='allowed',status='review' WHERE id='ticket'"
			);
			expect(
				yield* query(
					pg,
					'SELECT title,shout,note,status,party__person,party__company,revision FROM ticket'
				)
			).toEqual([
				{
					title: 'Original',
					shout: 'ORIGINAL',
					note: 'allowed',
					status: 'review',
					party__person: 'p',
					party__company: null,
					revision: 3
				}
			]);
			yield* script(pg, "UPDATE ticket SET status='done' WHERE id='ticket'");
			yield* rejected(pg, "UPDATE ticket SET note=NULL WHERE id='ticket'", '23514');
			yield* rejected(pg, "UPDATE ticket SET none='blocked' WHERE id='ticket'", '23514');
			yield* script(
				pg,
				"UPDATE ticket SET title='Original',note='allowed',status='done' WHERE id='ticket'"
			);
		})
);

it.effect(
	'raw audit writes cannot forge creation metadata, skip revisions or retain an invented actor',
	() =>
		Effect.gen(function* () {
			const pg = yield* stateDatabase;
			expect(yield* query(pg, 'SELECT revision,created_by,updated_by FROM ticket')).toEqual([
				{ revision: 1, created_by: null, updated_by: null }
			]);
			for (const text of [
				"INSERT INTO ticket (id,title,revision) VALUES ('forged','Forged',7)",
				"UPDATE ticket SET revision=100 WHERE id='ticket'",
				"UPDATE ticket SET revision=0 WHERE id='ticket'",
				"UPDATE ticket SET created_at='2000-01-01T00:00:00Z' WHERE id='ticket'",
				"UPDATE ticket SET created_by='forged' WHERE id='ticket'",
				"UPDATE ticket SET id='different' WHERE id='ticket'"
			])
				yield* rejected(pg, text, '23514');
			yield* script(
				pg,
				"UPDATE ticket SET title='Second',revision=revision,updated_at='2000-01-01T00:00:00Z',updated_by='forged' WHERE id='ticket'"
			);
			yield* script(pg, "UPDATE ticket SET title='Third',revision=revision+1 WHERE id='ticket'");
			expect(
				yield* query(
					pg,
					`SELECT id,title,revision,created_by,updated_by,
			updated_at > '2000-01-01T00:00:00Z'::timestamptz AS native_clock,
			created_at <= updated_at AS ordered_clock FROM ticket`
				)
			).toEqual([
				{
					id: 'ticket',
					title: 'Third',
					revision: 3,
					created_by: null,
					updated_by: null,
					native_clock: true,
					ordered_clock: true
				}
			]);
		})
);

it.effect(
	'restore context admits restored states and revisions while retaining keys, checks and foreign keys',
	() =>
		Effect.gen(function* () {
			const pg = yield* stateDatabase;
			const context = `SELECT set_config('store.write','{"mode":"restore","actor":"restorer","at":null}',true)`;
			yield* script(
				pg,
				`BEGIN; ${context}; INSERT INTO ticket (id,title,status,revision) VALUES ('restored','Restored','done',7); COMMIT;`
			);
			expect(yield* query(pg, "SELECT status,revision FROM ticket WHERE id='restored'")).toEqual([
				{ status: 'done', revision: 7 }
			]);
			yield* script(
				pg,
				`BEGIN; ${context}; UPDATE ticket SET title='Recovered',status='draft' WHERE id='restored'; COMMIT;`
			);
			expect(
				yield* query(pg, "SELECT title,status,revision FROM ticket WHERE id='restored'")
			).toEqual([{ title: 'Recovered', status: 'draft', revision: 8 }]);
			for (const [text, code] of [
				["UPDATE ticket SET id='moved' WHERE id='restored'", '23514'],
				["UPDATE ticket SET status='unknown' WHERE id='restored'", '23514'],
				["UPDATE ticket SET party__person='missing' WHERE id='restored'", '23503'],
				["INSERT INTO ticket (id,title,revision) VALUES ('zero','Invalid',0)", '23514']
			] as const) {
				yield* script(pg, `BEGIN; ${context};`);
				yield* rejected(pg, text, code).pipe(Effect.ensuring(script(pg, 'ROLLBACK')));
			}
		})
);

it.effect('raw scalar and array writes retain finite, bounded and flat value contracts', () =>
	Effect.gen(function* () {
		const declaration = schema({
			metric: table({
				key: 'text',
				fields: {
					ratio: { kind: 'number', min: 0, max: 1, default: 0.5 },
					free: { kind: 'number', default: 0 },
					amount: { kind: 'decimal', scale: 2, default: 0 },
					charge: { kind: 'money', currency: 'USD', default: 0 },
					day: { kind: 'date', default: '2026-10-25' },
					happened: { kind: 'instant', default: '2026-10-25T00:00:00Z' },
					clock: { kind: 'time', default: '12:00' },
					labels: { kind: 'text', many: true, max: 3, default: [] },
					emails: { kind: 'text', many: true, format: 'email', default: [] },
					tags: { kind: 'enum', many: true, values: ['a', 'b'], default: [] }
				}
			})
		});
		const pg = yield* database;
		yield* script(pg, (yield* build(declaration)).join(';\n'));
		yield* script(pg, "INSERT INTO metric (id) VALUES ('metric')");
		for (const set of [
			'ratio=-1',
			'ratio=2',
			"free='NaN'::float8",
			"free='Infinity'::float8",
			"free='-Infinity'::float8",
			"amount='NaN'::numeric",
			"amount='Infinity'::numeric",
			"amount='-Infinity'::numeric",
			"charge='NaN'::numeric",
			"charge='Infinity'::numeric",
			"day='infinity'::date",
			"day='-infinity'::date",
			"happened='infinity'::timestamptz",
			"clock='24:00'::time",
			"labels=ARRAY['four']::text[]",
			"labels=ARRAY['a',NULL]::text[]",
			"labels=ARRAY[['a'],['b']]::text[]",
			"emails=ARRAY['invalid']::text[]",
			"tags=ARRAY['unknown']::text[]",
			"tags=ARRAY['a',NULL]::text[]",
			"tags=ARRAY[['a'],['b']]::text[]"
		])
			yield* rejected(pg, `UPDATE metric SET ${set} WHERE id='metric'`, '23514');
		yield* script(
			pg,
			"UPDATE metric SET ratio=0.125,labels=ARRAY['one','two'],emails=ARRAY['a@example.com'],tags=ARRAY['a','b'] WHERE id='metric'"
		);
		expect(yield* query(pg, 'SELECT ratio,labels,emails,tags FROM metric')).toEqual([
			{ ratio: 0.125, labels: ['one', 'two'], emails: ['a@example.com'], tags: ['a', 'b'] }
		]);
	})
);

it.effect(
	'JSON defaults preserve scalar JSON and clock-shaped payload objects as literal data',
	() =>
		Effect.gen(function* () {
			const declaration = schema({
				payload: table({
					key: 'identity',
					fields: {
						text_value: { kind: 'json', default: '42' },
						bool_value: { kind: 'json', default: true },
						clock_payload: {
							kind: 'object',
							fields: { now: { kind: 'text' } },
							default: { now: '' }
						},
						actor_payload: { kind: 'json', default: { actor: 'literal' } },
						today_payload: { kind: 'json', default: { today: 'literal' } },
						at: { kind: 'instant', default: { now: '' } },
						on: { kind: 'date', default: { today: '' } }
					}
				})
			});
			const pg = yield* database;
			yield* script(pg, (yield* build(declaration)).join(';\n'));
			yield* script(pg, 'INSERT INTO payload DEFAULT VALUES');
			expect(
				yield* query(
					pg,
					`SELECT text_value,bool_value,clock_payload,actor_payload,today_payload,
			jsonb_typeof(text_value) AS text_type,isfinite(at) AND isfinite("on") AS clock_defaults FROM payload`
				)
			).toEqual([
				{
					text_value: '42',
					bool_value: true,
					clock_payload: { now: '' },
					actor_payload: { actor: 'literal' },
					today_payload: { today: 'literal' },
					text_type: 'string',
					clock_defaults: true
				}
			]);
		})
);
