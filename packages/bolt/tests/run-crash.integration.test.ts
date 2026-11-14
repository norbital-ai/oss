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
