// Query refusals, upsert conflict options and scalar-union inputs retain the authored behavior.
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Option, Result, Schema } from 'effect';
import { actFailure } from '../src/decl/errors.ts';
import { decodeManifest } from '../src/engine/manifest.ts';
import { TestWorkspace } from '../src/test/index.ts';
import { program } from './support/guest-fixture.ts';
import { actReply, qReply, routeFixture } from './support/route-fixture.ts';
import { uuidv7 } from '../src/protocol/wire.ts';
const manifest = Result.getOrThrow(
	decodeManifest({
		workspace: { tz: 'UTC', locale: 'en' },
		models: {
			rates: {
				description: 'A rate',
				label: 'code',
				key: ['code'],
				fields: { code: { kind: 'text' }, value: { kind: 'text' } }
			}
		},
		relationships: {},
		collections: {
			rates: {
				read: { fields: 'all' },
				create: { input: { columns: ['code', 'value'] } },
				update: { input: { columns: ['value'] } },
				queries: { check: { description: 'Refuses', input: {}, output: { kind: 'int' } } }
			}
		},
		integrations: {},
		policies: {
			rep: {
				description: 'Rep',
				automations: ['put'],
				grants: {
					rates: { read: true, create: true, update: true, queries: ['check'] }
				}
			}
		},
		teams: {},
		automations: {
			put: {
				description: 'Upsert one rate',
				input: {
					code: { kind: 'text' },
					id: { kind: 'id', of: 'rates', optional: true },
					v: { kind: 'union', of: [{ kind: 'bool' }, { kind: 'number' }, { kind: 'text' }] }
				},
				output: { kind: 'text' },
				runAs: 'trigger'
			}
		},
		connections: {},
		envoys: {},
		mcp: {},
		customFields: {},
		agent: { skills: {} },
		apps: {},
		groups: {},
		kiosks: {}
	})
);
const guest = program(`export default {
 collection: { rates: { bodies: {
	queries: { check: function* (input, ctx) { return yield* ctx.refuse('not today'); } }
 } } },
 automation: { put: { body: function* (input, ctx) {
		const saved=yield* ctx.act('rates.upsert', input.id ? { id: input.id, value: String(input.v) } : { code: input.code, value: String(input.v) }, { onConflict: 'update' });
		if(saved.kind!=='committed'||!saved.records[0])throw Error('Expected a committed rate');
		const rate=yield* ctx.query('rates',{id:saved.records[0].id});
		if(!rate||rate.value!==String(input.v))throw Error('The committed rate was not readable');
		return typeof input.v;
	} } }
};`);
const fixture = Effect.gen(function* () {
	const context = yield* Layer.build(TestWorkspace.layer({ manifest, guest: yield* guest }));
	const t = Context.get(context, TestWorkspace),
		route = yield* routeFixture(context),
		rep = t.as(t.member(['rep'])).authority;
	const startPut = (input: Schema.Json) => {
		const id = uuidv7(Date.parse(t.clock.now()));
		return actReply(route, rep, {
			callable: 'start',
			input: { automation: 'put', input, id },
			issuedAt: t.clock.now()
		}).pipe(
			Effect.flatMap((reply) => {
				const failure = actFailure(reply.outcome);
				return Option.isSome(failure) ? Effect.fail(failure.value) : Effect.succeed(id);
			})
		);
	};
	const run = (id: string) =>
		t.db.value(Schema.Struct({ state: Schema.String, output: Schema.Json }), {
			text: "SELECT jsonb_build_object('state',state,'output',output) FROM sys_run WHERE id=$1",
			params: [id]
		});
	const read = () =>
		qReply(route, rep, { reads: [{ m: 'query', a: ['rates', { all: true }] }] }).pipe(
			Effect.flatMap((reply) =>
				Schema.decodeUnknownEffect(
					Schema.Struct({
						rows: Schema.Array(
							Schema.Struct({ id: Schema.String, code: Schema.String, value: Schema.String })
						)
					})
				)(reply.answers[0])
			)
		);
	return { t, route, rep, startPut, run, read };
});
describe('ctx gaps', () => {
	it.live('a query refuses with ctx.refuse', () =>
		Effect.gen(function* () {
			const { route, rep } = yield* fixture;
			expect(
				yield* Effect.flip(qReply(route, rep, { reads: [{ m: 'query', a: ['rates.check', {}] }] }))
			).toMatchObject({ code: 'refused', message: 'not today' });
		})
	);
	it.live('a queued automation upserts through ctx.act with onConflict', () =>
		Effect.gen(function* () {
			const { t, startPut, run, read } = yield* fixture;
			const first = yield* startPut({ code: 'a', v: 1 });
			expect((yield* run(first)).state).toBe('queued');
			expect((yield* read()).rows).toEqual([]);
			yield* t.runDue();
			expect(yield* run(first)).toEqual({ state: 'succeeded', output: 'number' });
			const row = (yield* read()).rows[0];
			if (row === undefined) throw new Error('upsert produced no rate');
			const second = yield* startPut({ code: 'a', id: row.id, v: true });
			yield* t.runDue();
			expect(yield* run(second)).toEqual({ state: 'succeeded', output: 'boolean' });
			expect((yield* read()).rows.map((rate) => [rate.code, rate.value])).toEqual([['a', 'true']]);
		})
	);
	it.live('an untagged union input decodes by kind', () =>
		Effect.gen(function* () {
			const { t, startPut, run } = yield* fixture;
			const id = yield* startPut({ code: 'b', v: 'x' });
			yield* t.runDue();
			expect(yield* run(id)).toEqual({ state: 'succeeded', output: 'string' });
			expect(yield* Effect.flip(startPut({ code: 'b', v: [1] }))).toMatchObject({
				_tag: 'ActRefused',
				code: 'invalidInput',
				field: 'v'
			});
		})
	);
});
