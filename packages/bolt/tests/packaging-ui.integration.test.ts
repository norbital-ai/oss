/// <reference types="node" />
// Packaging gaps found migrating the 0.0.1 templates, on PGlite: a restore fills a column's default for a key a row
// omits (rule 70); `/runs` lists a holder's runs as rule 56 lets them read them.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Result } from 'effect';
import type { Authority } from '../src/engine/contracts.ts';
import { decodeProjectedManifest } from '../src/engine/manifest.ts';
import { runList } from '../src/engine/runs/index.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';

const manifest = Result.getOrThrow(
	decodeProjectedManifest({
		workspace: { tz: 'UTC', locale: 'en', apps: [] },
		models: {
			jobs: {
				description: 'Jobs',
				label: 'title',
				fields: {
					title: { kind: 'text' },
					status: { kind: 'enum', values: ['open', 'closed'], default: 'open' }
				}
			}
		},
		relationships: {},
		exposures: { jobs: { read: { jobs: { fields: 'all' } } } },
		integrations: {},
		policies: {},
		apps: {},
		teams: {},
		automations: {},
		connections: {},
		envoys: {},
		mcp: {},
		customFields: {},
		agent: { skills: {} }
	})
);

describe('seed restore', () => {
	it.live('gives a key a row omits its column default, not null', () =>
		Effect.gen(function* () {
			const context = yield* Layer.build(
				TestWorkspace.layer({
					manifest,
					seed: {
						jobs: [
							{ id: randomUUID(), title: 'A', status: 'closed' },
							{ id: randomUUID(), title: 'B' }
						]
					}
				})
			);
			const t = Context.get(context, TestWorkspace);
			const [r] = yield* t.db.read([
				{ text: 'SELECT title, status FROM jobs ORDER BY title', params: [] }
			]);
			if (r === undefined) throw new Error('seed result missing');
			expect(r.rows).toEqual([
				{ title: 'A', status: 'closed' },
				{ title: 'B', status: 'open' }
			]);
		})
	);
});

describe('/runs', () => {
	it.live(
		"lists a holder's runs of one automation in full, and a causing member's with the error code only",
		() =>
			Effect.gen(function* () {
				const context = yield* Layer.build(TestWorkspace.layer({ manifest }));
				const t = Context.get(context, TestWorkspace);
				// caused by the members' writes, not started by hand: a hand start answers its starter in full
				const run = (automation: string, actor: string) =>
					t.db.write({
						text: `INSERT INTO sys_run (id, automation, input, due_at, cause, depth, actor, state, error)
			VALUES ($1, $2, '{}', now(), 'direct', 0, $3, 'failed', '{"code":"invalid","message":"bad row 3"}')`,
						params: [randomUUID(), automation, actor]
					});
				yield* run('export', 'member:u9');
				yield* run('export', 'member:u2');
				yield* run('import', 'member:u9');
				const who = (id: string, automations: string[], external: boolean): Authority => ({
					key: id,
					admin: false,
					policies: [],
					models: {},
					automations,
					limits: [],
					teamTree: [],
					scopes: {},
					actor: {
						kind: 'member',
						id,
						email: null,
						phone: null,
						external,
						teams: [],
						teamPath: [],
						admin: false,
						party: null
					},
					capabilities: { apps: [], tools: [], mcp: [], skills: [] }
				});
				const holder = yield* runList(t.db, who('u1', ['export'], true), 10, 'export');
				expect(holder.map((r) => [r.automation, r.error])).toEqual([
					['export', { code: 'invalid', message: 'bad row 3' }],
					['export', { code: 'invalid', message: 'bad row 3' }]
				]);
				expect(yield* runList(t.db, who('u2', [], false), 10)).toEqual([
					expect.objectContaining({
						automation: 'export',
						status: 'failed',
						error: { code: 'invalid' }
					})
				]);
			})
	);
});
