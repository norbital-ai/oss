// Explicit create/update acts and scalar-union inputs retain the authored behavior without an upsert alias.
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Option, Result, Schema } from 'effect';
import { act_failure } from '../src/decl/errors/act.ts';
import { decode_projected_manifest } from '../src/engine/manifest.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { act_reply, q_reply, route_fixture } from './support/route-fixture.ts';
import { uuidv7 } from '../src/protocol/wire.ts';
const manifest = Result.getOrThrow(
	decode_projected_manifest({
		workspace: { tz: 'UTC', locale: 'en' },
		models: {
			rates: {
				description: 'A rate',
				record_label: 'record.code',
				key: ['code'],
				unique: [{ name: 'by_code', fields: ['code'], import_key: true }],
				fields: { code: { kind: 'text' }, value: { kind: 'text' } }
			}
		},
		relationships: {},
		exposures: {
			rates: {
				outputs: { default: { rates: { fields: 'all' } } },
				create: { columns: { rates: ['code', 'value'] } },
				update: { columns: { rates: ['value'] } }
			}
		},
		integrations: {},
		policies: {
			rep: {
				description: 'Rep',
				capabilities: { automations: ['put'] },
				grants: {
					rates: { outputs: { default: {} }, create: {}, update: {} }
				}
			}
		},
		teams: {},
		automations: {
			put: {
				description: 'Create or update one rate',
				input: {
					code: { kind: 'text' },
					id: { kind: 'ref', to: 'rates', optional: true },
					v: { kind: 'union', of: [{ kind: 'bool' }, { kind: 'number' }, { kind: 'text' }] }
				},
				output: { kind: 'text' },
				policies: ['rep']
			}
		},
		mcp: {},
		custom_fields: {},
		agent: { skills: {} },
		apps: {},
		groups: {}
	})
);
const guest = program(`export default {
 automation: { put: { body: function* (input, ctx) {
		const prior = (yield* ctx.query({ rates: { where: input.id ? { id: { eq: input.id } } : { code: { eq: input.code } }, limit: 1 } })).rates.rows[0];
		const saved = yield* ctx.act(prior
			? { 'rates.update': [{ target: prior, set: { value: String(input.v) } }] }
			: { 'rates.create': [{ code: input.code, value: String(input.v) }] });
		if(saved.kind!=='committed'||!saved.records[0])throw Error('Expected a committed rate');
		const rate=(yield* ctx.query({rates:{where:{id:{eq:saved.records[0].id}}}})).rates.rows[0];
		if(!rate||rate.value!==String(input.v))throw Error('The committed rate was not readable');
		return typeof input.v;
	} } }
};`);
const fixture = Effect.gen(function* () {
	const context = yield* Layer.build(TestWorkspace.layer({ manifest, guest: yield* guest }));
	const t = Context.get(context, TestWorkspace),
		route = yield* route_fixture(context),
		rep = (yield* t.as(t.member(['rep']))).authority;
	const startPut = (input: Schema.Json) => {
		const id = uuidv7(Date.parse(t.clock.now()));
		return act_reply(route, rep, {
			callable: 'run',
			input: { automation: 'put', input, id },
			issued_at: t.clock.now()
		}).pipe(
			Effect.flatMap((reply) => {
				const failure = act_failure(reply.outcome);
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
		q_reply(route, rep, { reads: [{ m: 'query', a: [{ rates: {} }] }] }).pipe(
			Effect.flatMap((reply) =>
				Schema.decodeUnknownEffect(
					Schema.Struct({
						rates: Schema.Struct({
							rows: Schema.Array(
								Schema.Struct({ id: Schema.String, code: Schema.String, value: Schema.String })
							)
						})
					})
				)(reply.answers[0])
			),
			Effect.map((answer) => answer.rates)
		);
	return { t, route, rep, startPut, run, read };
});
describe('ctx gaps', () => {
	it.live('a queued automation explicitly creates or updates the row it read', () =>
		Effect.gen(function* () {
			const { t, startPut, run, read } = yield* fixture;
			const first = yield* startPut({ code: 'a', v: 1 });
			expect((yield* run(first)).state).toBe('queued');
			expect((yield* read()).rows).toEqual([]);
			yield* t.run_due();
			expect(yield* run(first)).toEqual({ state: 'succeeded', output: 'number' });
			const row = (yield* read()).rows[0];
			if (row === undefined) throw new Error('Write produced no rate');
			const second = yield* startPut({ code: 'a', id: row.id, v: true });
			yield* t.run_due();
			expect(yield* run(second)).toEqual({ state: 'succeeded', output: 'boolean' });
			expect((yield* read()).rows.map((rate) => [rate.code, rate.value])).toEqual([['a', 'true']]);
		})
	);
	it.live('an untagged union input decodes by kind', () =>
		Effect.gen(function* () {
			const { t, startPut, run } = yield* fixture;
			const id = yield* startPut({ code: 'b', v: 'x' });
			yield* t.run_due();
			expect(yield* run(id)).toEqual({ state: 'succeeded', output: 'string' });
			expect(yield* Effect.flip(startPut({ code: 'b', v: [1] }))).toMatchObject({
				_tag: 'ActRefused',
				code: 'invalid_input',
				field: 'v'
			});
		})
	);
});
