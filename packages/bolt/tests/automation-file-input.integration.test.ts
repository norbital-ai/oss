// An automation's `file` input from a page: a member who may start it uploads to `<automation>.$input.<input>`, the
// file is the automation's (its runs read it), and the start names the answered `FileRef`. Others are refused.
import { Context, Effect, Layer, Schema } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { JobResult, TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: { logs: { description: 'A log line', record_label: 'record.note', fields: { note: { kind: 'text' } } } },
	relationships: {},
	exposures: {
		logs: { outputs: { default: { logs: { fields: 'all' } } }, create: { columns: { logs: ['note'] } } }
	},
	policies: {
		ops: {
			description: 'Ops',
			grants: { logs: { outputs: { default: {} }, create: {} } },
			capabilities: { automations: ['ingest'] }
		},
		viewer: { description: 'Viewer', grants: { logs: { outputs: { default: {} } } } }
	},
	automations: {
		ingest: {
			description: 'Notes the uploaded file',
			input: { file: { kind: 'file', accept: ['text/csv'], max: '1MiB' } },
			policies: ['ops']
		}
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
		ingest: { body: function* (input, ctx) {
			const bytes = yield* ctx.files.get(input.file);
			yield* ctx.act({ 'logs.create': [{ note: new TextDecoder().decode(bytes) }] });
		} }
	}
};`;
const csv = { name: 'rows.csv', mime: 'text/csv', bytes: new TextEncoder().encode('a,b') };

describe('an automation file input', () => {
	it.live('is uploaded by a starter, owned by the automation and read by its run', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const t = Context.get(
					yield* Layer.build(
						TestWorkspace.layer({ manifest, guest: yield* program(guestSource), now: '2026-09-25T10:00:00.000Z' })
					),
					TestWorkspace
				);
				const ops = yield* t.as(t.member(['ops']));
				const uploaded = yield* ops.upload('ingest.$input.file', csv);
				if (uploaded.kind !== 'committed') throw new Error('upload held');
				expect(
					yield* t.db.value(Schema.String, {
						text: 'SELECT field FROM sys_file WHERE id = $1',
						params: [uploaded.output.id]
					})
				).toBe('ingest');
				// the fixture's automation is not in the type registry
				const automation: string = 'ingest';
				const started = yield* ops.run(automation, { file: uploaded.output }, JobResult);
				expect(started.kind).toBe('committed');
				yield* t.run_due();
				expect(
					yield* t.db.rows(Schema.Struct({ note: Schema.String }), { text: 'SELECT note FROM logs', params: [] })
				).toEqual([{ note: 'a,b' }]);
				const viewer = yield* t.as(t.member(['viewer']));
				expect(yield* Effect.flip(viewer.upload('ingest.$input.file', csv))).toMatchObject({ code: 'forbidden' });
				expect(
					yield* Effect.flip(ops.upload('ingest.$input.file', { ...csv, mime: 'image/png' }))
				).toMatchObject({ code: 'invalid_input' });
			})
		)
	);
});
