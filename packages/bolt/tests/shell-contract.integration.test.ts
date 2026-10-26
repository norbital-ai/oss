// `shellApi.act` (the inbox's and the agent panel's callables) states the schema the shell booted against in
// `Bolt-Contract` (L-BOLT-171), as `$bolt` does: a page of a retired release is refused `releaseChanged`, never acted on.
import { describe, expect, it } from '@effect/vitest';
import { Clock, Context, Effect, FiberSet, Layer, Result } from 'effect';
import { decodeManifest } from '../src/engine/manifest.ts';
import { routeFixture } from './support/route-fixture.ts';
import { fingerprint, schemaSlice } from '../src/engine/schema/plan.ts';
import { HEADERS, PATHS } from '../src/protocol/wire.ts';
import { SHELL } from '../src/shell/nav.ts';
import { shellApi } from '../src/shell/runtime.ts';
import { TestWorkspace } from '../src/test/index.ts';

const manifest = Result.getOrThrow(
	decodeManifest({
		workspace: { tz: 'UTC', locale: 'en' },
		models: { docs: { description: 'A doc', label: 'title', fields: { title: { kind: 'text' } } } },
		relationships: {},
		collections: { docs: { read: { fields: 'all' } } },
		policies: {},
		automations: {},
		integrations: {},
		teams: {},
		connections: {},
		envoys: {},
		mcp: {},
		apps: {},
		customFields: {},
		agent: { skills: {} }
	})
);
const RETIRED = '0'.repeat(64);
const ORIGIN = 'http://cell';

/**
 * The shell api over the real `/__bolt/act`; the boot (the shell host's) only names `booted`, by default the handler's own
 * schema. Records each act's `Bolt-Contract`.
 */
const shell = (booted?: string) =>
	Effect.gen(function* () {
		const context = yield* Layer.build(
			TestWorkspace.layer({ manifest, now: new Date(yield* Clock.currentTimeMillis).toISOString() })
		);
		const t = Context.get(context, TestWorkspace),
			route = yield* routeFixture(context);
		const current = fingerprint(schemaSlice(t.manifest)),
			contract = booted ?? current,
			admin = t.as(t.admin).authority;
		const run = yield* FiberSet.makeRuntimePromise<never>().pipe(Effect.provide(context));
		const stated: (string | null)[] = [];
		const fetch: typeof globalThis.fetch = (input, init) => {
			const request = new Request(
				input instanceof Request ? input : new URL(String(input), ORIGIN),
				init
			);
			const path = new URL(request.url).pathname;
			if (path === SHELL) return Promise.resolve(Response.json({ value: { contract } }));
			if (path === PATHS.act) stated.push(request.headers.get(HEADERS.contract));
			return run(route.handle(admin, request), { signal: request.signal });
		};
		const nativeApi = shellApi(fetch, { base: ORIGIN });
		const api = {
			...nativeApi,
			markAllNoticesRead: () => nativeApi.markAllNoticesRead().pipe(Effect.provide(context))
		};
		expect(yield* api.boot()).toMatchObject({ contract });
		return { api, stated, current };
	});

describe('shellApi.act states the booted Bolt-Contract (L-BOLT-171)', () => {
	it.live('the booted contract passes', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { api, stated, current } = yield* shell();
				expect(yield* api.markAllNoticesRead()).toMatchObject({ kind: 'committed' });
				expect(stated).toEqual([current]);
			})
		)
	);

	it.live("a retired release's page is refused releaseChanged", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { api, stated } = yield* shell(RETIRED);
				expect(yield* api.markAllNoticesRead()).toMatchObject({
					kind: 'refused',
					code: 'releaseChanged'
				});
				expect(stated).toEqual([RETIRED]);
			})
		)
	);
});
