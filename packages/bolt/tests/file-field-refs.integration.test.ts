// An uploaded file's reference, as `ctx.upload` and the file control answer it (`bytes`, `sha256` beside the ref), is
// accepted by a multi-file field exactly as by a single-file field, and both store the same file reference.
import { expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Schema } from 'effect';
import { act_reply, route_fixture } from './support/route-fixture.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';

const file = { kind: 'file', accept: ['*/*'], max: '20MiB' } as const;
const manifest = {
	workspace: { tz: 'UTC', locale: 'en', agent: { triage: false } },
	models: {
		reports: {
			description: 'A report',
			record_label: 'record.name',
			fields: { name: { kind: 'text' }, cover: { ...file, optional: true }, pages: { ...file, many: true, optional: true } }
		}
	},
	relationships: {},
	exposures: {
		reports: {
			outputs: { default: { reports: { fields: 'all' } } },
			create: { columns: { reports: ['name', 'cover', 'pages'] } }
		}
	},
	policies: {},
	agent: { skills: {} },
	integrations: {},
	teams: {},
	automations: {},
	mcp: {},
	apps: {},
	custom_fields: {},
	needs: []
} satisfies EngineManifest;

it.live('single- and multi-file fields accept an uploaded reference and store the same ref', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const context = yield* Layer.build(TestWorkspace.layer({ manifest }));
			const t = Context.get(context, TestWorkspace),
				route = yield* route_fixture(context);
			const admin = yield* t.as(t.admin);
			const upload = (field: string, name: string) =>
				admin.upload(`reports.${field}`, { name, mime: 'application/pdf', bytes: new Uint8Array([1, 2, 3]) }).pipe(
					Effect.flatMap((answer) => (answer.kind === 'committed' ? Effect.succeed(answer.output) : Effect.die(answer)))
				);
			const cover = yield* upload('cover', 'cover.pdf');
			const page = yield* upload('pages', 'page.pdf');
			expect(cover).toMatchObject({ bytes: 3, sha256: expect.any(String) });
			const { outcome } = yield* act_reply(route, admin.authority, {
				acts: { 'reports.create': [{ name: 'Q3', cover, pages: [page] }] },
				issued_at: t.clock.now()
			});
			expect(outcome.kind).toBe('committed');
			const [row] = yield* t.db.rows(Schema.Struct({ cover: Schema.Json, pages: Schema.Json }), {
				text: 'SELECT cover, pages FROM reports',
				params: []
			});
			const stored = (ref: typeof cover) => ({ id: ref.id, name: ref.name, mime: ref.mime, size: 3 });
			expect(row).toEqual({ cover: stored(cover), pages: [stored(page)] });
		})
	)
);
