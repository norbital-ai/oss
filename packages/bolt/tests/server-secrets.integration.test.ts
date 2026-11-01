import { expect, it } from '@effect/vitest';
import { Context, Effect, Layer } from 'effect';
import type { EngineManifest } from '../src/engine/manifest.ts';
import type { Invocation, InvocationKind } from '../src/engine/contracts.ts';
import { Guest, type Bridge } from '../src/engine/services.ts';
import { Secrets } from '../src/engine/secrets.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';

const manifest: EngineManifest = {
	needs: [],
	workspace: { tz: 'UTC', locale: 'en', secrets: { TOKEN: { label: 'Synthetic token' } } },
	models: {},
	relationships: {},
	exposures: {},
	policies: { server: { description: 'Server configuration fixture', grants: {} } },
	teams: {},
	automations: { check: { description: 'Check server configuration', policies: ['server'] } },
	integrations: {},
	connections: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} }
};
const source = program(`import { Config, Option, Redacted } from 'effect';
function* helper(input, ctx) {
 const token = yield* Config.Redacted('TOKEN');
 const missing = yield* Config.option(Config.String('PATH'));
 return { matches: Redacted.value(token) === input, ambientAbsent: Option.isNone(missing), contextClean: !('$secrets' in ctx) };
}
const body = function* (input, ctx) { return yield* helper(input, ctx); };
export default { automation: { check: { body } }, model: { example: { bodies: { create: body } } }, page: { example: { body } } };`);
const noCalls: Bridge = {
	cross: () => Effect.die('Configuration reads do not need model or facility authority.')
};
const invocation = (kind: InvocationKind, value: string): Invocation => ({
	id: `secret-${kind}`,
	kind,
	target: kind === 'automation' ? 'check' : 'example',
	input: value,
	ctx: {
		actor: { kind: 'system', run: 'secret-test', by: { platform: 'test' } },
		now: '2026-10-31T00:00:00Z',
		today: '2026-10-31',
		tz: 'UTC',
		seed: 'secret-test'
	},
	budget: { crossings: 0, readBytes: 0 }
});

it.effect(
	'declared tenant secrets reach server helpers, callbacks and loaders; rotation is visible on the next invocation',
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const context = yield* Layer.build(TestWorkspace.layer({ manifest, guest: yield* source }));
				const secrets = Context.get(context, Secrets),
					guest = Context.get(context, Guest);
				yield* secrets.set('workspace', 'TOKEN', 'synthetic-alpha');
				for (const kind of ['automation', 'create', 'page'] as const)
					expect(yield* guest.invoke(invocation(kind, 'synthetic-alpha'), noCalls)).toEqual({
						kind: 'ok',
						output: { matches: true, ambientAbsent: true, contextClean: true }
					});
				const other = yield* Layer.build(TestWorkspace.layer({ manifest, guest: yield* source }));
				yield* Context.get(other, Secrets).set('workspace', 'TOKEN', 'synthetic-other-tenant');
				expect(
					yield* Context.get(other, Guest).invoke(
						invocation('automation', 'synthetic-alpha'),
						noCalls
					)
				).toMatchObject({ kind: 'ok', output: { matches: false } });
				expect(
					yield* Context.get(other, Guest).invoke(
						invocation('automation', 'synthetic-other-tenant'),
						noCalls
					)
				).toMatchObject({ kind: 'ok', output: { matches: true } });
				yield* secrets.set('workspace', 'TOKEN', 'synthetic-beta');
				expect(
					yield* guest.invoke(invocation('automation', 'synthetic-beta'), noCalls)
				).toMatchObject({ kind: 'ok', output: { matches: true } });
				yield* secrets.clear('workspace', 'TOKEN');
				expect(
					yield* guest.invoke(invocation('automation', 'synthetic-beta'), noCalls)
				).toMatchObject({ kind: 'failed' });
			})
		)
);
