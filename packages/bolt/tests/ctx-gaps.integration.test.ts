// Query refusals, upsert conflict options and scalar-union inputs retain the authored behavior.
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Option, Result, Schema } from 'effect';
import { actFailure } from '../src/decl/errors.ts';
import { decodeManifest } from '../src/engine/manifest.ts';
import { TestWorkspace } from '../src/test/index.ts';
import { program } from './support/guest-fixture.ts';
import { actReply, qReply, routeFixture } from './support/route-fixture.ts';
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
				queries: { check: { description: 'Refuses', input: {}, output: { kind: 'int' } } },
				actions: {
					put: {
						description: 'Upsert one rate',
						input: {
							code: { kind: 'text' },
							id: { kind: 'id', of: 'rates', optional: true },
							v: { kind: 'union', of: [{ kind: 'bool' }, { kind: 'number' }, { kind: 'text' }] }
						},
						output: { kind: 'text' }
					}
				}
			}
		},
		integrations: {},
		pipelines: {},
		policies: {
			rep: {
				description: 'Rep',
				grants: {
					rates: { read: true, create: true, update: true, queries: ['check'], actions: ['put'] }
				}
			}
		},
		teams: {},
		automations: {},
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
const guest = program(`export default { collection: { rates: { bodies: {
	queries: { check: function* (input, ctx) { return yield* ctx.refuse('not today'); } },
	actions: { put: function* (input, ctx) {
		yield* ctx.act('rates.upsert', input.id ? { id: input.id, value: String(input.v) } : { code: input.code, value: String(input.v) }, { onConflict: 'update' });
		return typeof input.v;
	} }
} } } };`);
const fixture = Effect.gen(function* () {
	const context = yield* Layer.build(TestWorkspace.layer({ manifest, guest: yield* guest }));
	const t = Context.get(context, TestWorkspace),
		route = yield* routeFixture(context),
		rep = t.as(t.member(['rep'])).authority;
	const put = (input: Schema.Json) =>
		actReply(route, rep, { callable: 'rates.put', input, issuedAt: t.clock.now() }).pipe(
			Effect.flatMap((reply) => {
				const failure = actFailure(reply.outcome);
				return Option.isSome(failure) ? Effect.fail(failure.value) : Effect.succeed(reply.outcome);
			})
		);
	const read = () =>
		qReply(route, rep, { reads: [{ m: 'read', a: ['rates', { all: true }] }] }).pipe(
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
	return { route, rep, put, read };
});
describe('ctx gaps', () => {
	it.live('a query refuses with ctx.refuse', () =>
		Effect.gen(function* () {
			const { route, rep } = yield* fixture;
			expect(
				yield* Effect.flip(
					qReply(route, rep, { reads: [{ m: 'query', a: ['rates', 'check', {}] }] })
				)
			).toMatchObject({ code: 'refused', message: 'not today' });
		})
	);
	it.live('an action upserts through ctx.act with onConflict', () =>
		Effect.gen(function* () {
			const { put, read } = yield* fixture;
			const first = yield* put({ code: 'a', v: 1 });
			if (first.kind !== 'committed') throw new Error(JSON.stringify(first));
			expect(first.output).toBe('number');
			const row = (yield* read()).rows[0];
			if (row === undefined) throw new Error('upsert produced no rate');
			const second = yield* put({ code: 'a', id: row.id, v: true });
			if (second.kind !== 'committed') throw new Error(JSON.stringify(second));
			expect(second.output).toBe('boolean');
			expect((yield* read()).rows.map((rate) => [rate.code, rate.value])).toEqual([['a', 'true']]);
		})
	);
	it.live('an untagged union input decodes by kind', () =>
		Effect.gen(function* () {
			const { put } = yield* fixture;
			const out = yield* put({ code: 'b', v: 'x' });
			if (out.kind !== 'committed') throw new Error(JSON.stringify(out));
			expect(out.output).toBe('string');
			expect(yield* Effect.flip(put({ code: 'b', v: [1] }))).toMatchObject({
				_tag: 'ActRefused',
				code: 'invalidInput',
				field: 'v'
			});
		})
	);
});
