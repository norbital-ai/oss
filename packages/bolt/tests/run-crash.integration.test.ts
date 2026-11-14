// `t.crash` is the host dying as a run ends: the end is never recorded, no retry runs, and the run stays `running`
// until its lease runs out; the next wake past the lease reclaims it and reruns it from the start.
import { Context, Effect, Layer, Schema } from 'effect';
import { expect, it } from '@effect/vitest';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { JobResult, TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		logs: { description: 'A log line', record_label: 'record.note', fields: { note: { kind: 'text' } } }
	},
	relationships: {},
	exposures: {
		logs: { outputs: { default: { logs: { fields: 'all' } } }, create: { columns: { logs: ['note'] } } }
	},
	policies: {
		ops: {
			description: 'Ops',
			grants: { logs: { outputs: { default: {} }, create: {} } },
			capabilities: { automations: ['note'] }
		}
	},
	automations: { note: { description: 'Writes a log line', policies: ['ops'] } },
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
		note: { body: function* (_input, ctx) {
			yield* ctx.act({ 'logs.create': [{ note: 'ran' }] });
		} }
	}
};`;
const Run = Schema.Struct({ state: Schema.String, leases: Schema.Number, attempts: Schema.Number });

it.live('a crashed run is left running, then its lease reclaims and reruns it', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const t = Context.get(
				yield* Layer.build(
					TestWorkspace.layer({ manifest, guest: yield* program(guestSource), now: '2026-09-25T10:00:00.000Z' })
				),
				TestWorkspace
			);
			const ops = yield* t.as(t.member(['ops']));
			// the fixture's names are not in the type registry
			const automation: string = 'note';
			const started = yield* ops.run(automation, {}, JobResult);
			if (started.kind !== 'committed') throw new Error('note was not admitted');
			const id = started.output.id;
			const run = t.db.rows(Run, {
				text: 'SELECT state, leases, attempts FROM sys_run WHERE id = $1',
				params: [id]
			});
			yield* t.crash(id);
			expect(yield* run).toEqual([{ state: 'running', leases: 0, attempts: 1 }]);
			// inside the lease nothing reclaims it
			yield* t.run_due();
			expect(yield* run).toEqual([{ state: 'running', leases: 0, attempts: 1 }]);
			t.clock.advance('31min');
			yield* t.run_due();
			expect(yield* run).toEqual([{ state: 'succeeded', leases: 1, attempts: 2 }]);
		})
	)
);

// a run queued behind a crashed one (concurrency 1) is not due at the crash's instant: it waits for the crashed run's lease
it.live('a run behind a crashed run waits for its lease, then both run', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const t = Context.get(
				yield* Layer.build(
					TestWorkspace.layer({ manifest, guest: yield* program(guestSource), now: '2026-09-25T10:00:00.000Z' })
				),
				TestWorkspace
			);
			const ops = yield* t.as(t.member(['ops']));
			const automation: string = 'note';
			const first = yield* ops.run(automation, {}, JobResult);
			// the second queues a second later, so the claim takes the first
			t.clock.advance('1s');
			const second = yield* ops.run(automation, {}, JobResult);
			if (first.kind !== 'committed' || second.kind !== 'committed') throw new Error('note was not admitted');
			const states = t.db.rows(Schema.Struct({ id: Schema.String, state: Schema.String }), {
				text: 'SELECT id::text AS id, state FROM sys_run WHERE id::text IN (SELECT jsonb_array_elements_text($1::jsonb))',
				params: [[first.output.id, second.output.id]]
			});
			const stateOf = (rows: readonly { id: string; state: string }[], id: string) =>
				rows.find((row) => row.id === id)?.state;
			yield* t.crash(first.output.id);
			// nothing is due: the queued run has no room until the crashed one's lease runs out
			expect((yield* t.run_due()).failed).toEqual([]);
			const held = yield* states;
			expect(stateOf(held, first.output.id)).toBe('running');
			expect(stateOf(held, second.output.id)).toBe('queued');
			// a waiting run past its deadline with no room is no reason to wake either
			yield* t.db.write({
				text: `UPDATE sys_run SET state = 'waiting', due_at = $2::timestamptz WHERE id = $1`,
				params: [second.output.id, '2026-09-25T09:59:00.000Z']
			});
			expect((yield* t.run_due()).failed).toEqual([]);
			expect(stateOf(yield* states, second.output.id)).toBe('waiting');
			yield* t.db.write({
				text: `UPDATE sys_run SET state = 'queued' WHERE id = $1`,
				params: [second.output.id]
			});
			t.clock.advance('31min');
			expect((yield* t.run_due()).failed).toEqual([]);
			const ran = yield* states;
			expect(stateOf(ran, first.output.id)).toBe('succeeded');
			expect(stateOf(ran, second.output.id)).toBe('succeeded');
		})
	)
);
