// `ctx.wait` end to end through the test kit: a waiting run holds no lane and ends its attempt; its deadline, or a
// matching write, queues it again, and the resumed attempt answers every call before the wait from its journal (the act
// before the wait commits once) and the wait with what woke it. A write that does not match `where` puts it back to wait.
import { Context, Effect, Layer, Schema } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { JobResult, TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import type { Json } from '../src/decl/values.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		quotes: {
			description: 'A quote',
			record_label: 'record.title',
			fields: {
				title: { kind: 'text' },
				status: { kind: 'enum', values: ['draft', 'sent'], default: 'draft' }
			}
		},
		logs: { description: 'A log line', record_label: 'record.note', fields: { note: { kind: 'text' } } }
	},
	relationships: {},
	exposures: {
		quotes: {
			outputs: { default: { quotes: { fields: 'all' } } },
			create: { columns: { quotes: ['title'] } },
			update: { columns: { quotes: ['title', 'status'] } }
		},
		logs: { outputs: { default: { logs: { fields: 'all' } } }, create: { columns: { logs: ['note'] } } }
	},
	policies: {
		ops: {
			description: 'Ops',
			grants: {
				quotes: { outputs: { default: {} }, create: {}, update: {} },
				logs: { outputs: { default: {} }, create: {} }
			},
			capabilities: { automations: ['later', 'follow'] }
		}
	},
	automations: {
		later: { description: 'Waits for its deadline', input: { until: { kind: 'instant' } }, policies: ['ops'] },
		follow: { description: 'Waits for a sent quote', input: { until: { kind: 'instant' } }, policies: ['ops'] }
	},
	integrations: {},
	teams: {},
	mcp: {},
	apps: {},
	custom_fields: {},
	agent: { skills: {} },
	needs: []
} satisfies EngineManifest;
const guestSource = `export default {
	automation: {
		later: { body: function* (input, ctx) {
			yield* ctx.act({ 'logs.create': [{ note: 'before' }] });
			const woke = yield* ctx.wait({ until: input.until });
			yield* ctx.act({ 'logs.create': [{ note: woke.kind }] });
		} },
		follow: { body: function* (input, ctx) {
			yield* ctx.act({ 'logs.create': [{ note: 'before' }] });
			const woke = yield* ctx.wait({ model: 'quotes', where: { status: { eq: 'sent' } }, until: input.until });
			yield* ctx.act({ 'logs.create': [{ note: woke.kind }] });
		} }
	}
};`;
const State = Schema.NullOr(Schema.String);
/** An act map over the fixture's models, which the type registry does not name. */
const untyped = (acts: { readonly [callable: string]: Json }) => acts;
const Note = Schema.Struct({ note: Schema.String });

const fixture = Effect.gen(function* () {
	const context = yield* Layer.build(
		TestWorkspace.layer({ manifest, guest: yield* program(guestSource), now: '2026-09-25T10:00:00.000Z' })
	);
	const t = Context.get(context, TestWorkspace);
	const ops = yield* t.as(t.member(['ops']));
	const state = (id: string) =>
		t.db.value(State, { text: 'SELECT state FROM sys_run WHERE id = $1', params: [id] });
	const notes = t.db.rows(Note, { text: 'SELECT note FROM logs ORDER BY created_at, note', params: [] });
	/** Starts `name` and answers its run id (the fixture's names are not in the type registry). */
	const start = (name: string, until: string) =>
		Effect.map(ops.run(name, { until }, JobResult), (started) => {
			if (started.kind !== 'committed') throw new Error(`${name} was not admitted`);
			return started.output.id;
		});
	return { t, ops, state, notes, start };
});

describe('ctx.wait', () => {
	it.live('waits for its deadline holding no lane, then resumes without repeating the act before it', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { t, state, notes, start } = yield* fixture;
				const run = yield* start('later', '2026-09-26T10:00:00.000Z');
				yield* t.run_due();
				expect(yield* state(run)).toBe('waiting');
				expect(yield* notes).toEqual([{ note: 'before' }]);
				t.clock.advance('1d');
				yield* t.run_due();
				expect(yield* state(run)).toBe('succeeded');
				expect(yield* notes).toEqual([{ note: 'before' }, { note: 'time' }]);
			})
		)
	);

	it.live('wakes on a matching write only; another write to the model puts it back to wait', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { t, ops, state, notes, start } = yield* fixture;
				const created = yield* ops.act(untyped({ 'quotes.create': [{ title: 'q1' }] }));
				const quote = created.records[0];
				if (quote === undefined) throw new Error('Missing quote');
				const run = yield* start('follow', '2026-10-25T10:00:00.000Z');
				yield* t.run_due();
				expect(yield* state(run)).toBe('waiting');
				const renamed = yield* ops.act(untyped({ 'quotes.update': [{ target: quote, set: { title: 'q2' } }] }));
				yield* t.run_due();
				expect(yield* state(run)).toBe('waiting');
				const target = renamed.records[0];
				if (target === undefined) throw new Error('Missing quote');
				yield* ops.act(untyped({ 'quotes.update': [{ target, set: { status: 'sent' } }] }));
				yield* t.run_due();
				expect(yield* state(run)).toBe('succeeded');
				expect(yield* notes).toEqual([{ note: 'before' }, { note: 'event' }]);
			})
		)
	);
});
