import { randomUUID } from 'node:crypto';
import { expect, it } from '@effect/vitest';
import { Context, Effect, Layer } from 'effect';
import { fileSyncHandlers } from '../src/engine/sync/file.ts';
import { Facilities, Guest, type FacilityCall } from '../src/engine/services.ts';
import type { CrossAnswer, GuestOutcome } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { TestWorkspace } from '../src/test/index.ts';
import { manifest as base } from './write-fixture.ts';

const manifest: EngineManifest = {
	...base,
	models: {
		documents: {
			description: 'Documents',
			label: 'title',
			fields: { title: { kind: 'text' } }
		}
	},
	relationships: {},
	exposures: {
		documents: {
			read: { documents: { fields: 'all' } },
			syncs: { sheet: { with: 'file', parser: ['csv'], write: true } }
		}
	}
};

it.live('the native file-export bridge admits bytes and images and refuses other facilities', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const context = yield* Layer.build(TestWorkspace.layer({ manifest }));
			const t = Context.get(context, TestWorkspace);
			const guest = Context.get(context, Guest);
			const facilities = Context.get(context, Facilities);
			const dispatched: FacilityCall['_tag'][] = [];
			const calls: readonly FacilityCall[] = [
				{ _tag: 'files.get', args: [{ id: 'signature' }] },
				{ _tag: 'files.image', args: [{ id: 'signature' }, { jpeg: { maxEdge: 512 } }] },
				{ _tag: 'files.put', args: [] },
				{ _tag: 'files.text', args: [] },
				{ _tag: 'web.read', args: [] },
				{ _tag: 'ai.embed', args: [] }
			];
			const handlers = yield* fileSyncHandlers.pipe(
				Effect.provideService(Guest, {
					...guest,
					invoke: (invocation, bridge) =>
						Effect.gen(function* () {
							expect(invocation.kind).toBe('syncWrite');
							expect(invocation.ctx.fileExport).toBe(true);
							const answers = yield* bridge.cross(calls);
							expect(answers.map((answer) => answer.ok)).toEqual([
								true,
								true,
								false,
								false,
								false,
								false
							]);
							for (const answer of answers.slice(2)) {
								if (answer.ok) throw new Error('Unexpected facility access');
								expect(answer.error).toMatchObject({ kind: 'bolt', code: 'unsupported' });
							}
							return {
								kind: 'ok',
								output: [{ title: 'Rendered document' }]
							} satisfies GuestOutcome;
						})
				}),
				Effect.provideService(Facilities, {
					...facilities,
					dispatch: (call) =>
						Effect.sync(() => {
							dispatched.push(call._tag);
							return { ok: true, value: null } satisfies CrossAnswer;
						})
				}),
				Effect.provide(context)
			);
			const handler = handlers['documents.sync.sheet'];
			if (handler === undefined) throw new Error('Missing file export');
			yield* handler({ mode: 'export', to: 'csv' }, { id: randomUUID(), starter: t.admin });
			expect(dispatched).toEqual(['files.get', 'files.image']);
		})
	)
);
