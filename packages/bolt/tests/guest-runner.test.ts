// Mutations: dropping final[4] loses timeout retry classification.
import { expect, it } from '@effect/vitest';
import { Context, Effect, Layer } from 'effect';
import { LIMITS, type Invocation } from '../src/engine/contracts.ts';
import { Guest, type Bridge } from '../src/engine/services.ts';
import { guestLayer } from './support/guest-fixture.ts';
import vm from 'node:vm';
import { moduleScript } from '../src/node/guest-hooks.ts';
const invocation: Invocation = {
	id: 'scope',
	kind: 'automation',
	target: 'a',
	input: null,
	ctx: {
		actor: { kind: 'system', run: 'run', by: { platform: 'test' } },
		now: '2026-01-01T00:00:00.000Z',
		today: '2026-01-01',
		tz: 'UTC',
		seed: 'scope'
	},
	budget: {
		crossings: LIMITS.crossings.sync,
		readBytes: LIMITS.readBytes
	}
};
const noCalls: Bridge = { cross: () => Effect.succeed([]) };
it.live('copies facility failure kind onto the guest error cause', () =>
	Effect.gen(function* () {
		const context = yield* Layer.build(
			guestLayer({
				source:
					'export default { automation: { a: { body: () => { const e = new Error("slow"); e.kind = "timeout"; throw e; } } } };'
			})
		);
		const answer = yield* Context.get(context, Guest).invoke(invocation, noCalls);
		expect(answer).toMatchObject({
			kind: 'failed',
			error: { code: 'guestError', cause: { kind: 'timeout', message: 'slow' } }
		});
	})
);
it.live('maps a guest error to its authored location', () =>
	Effect.gen(function* () {
		const context = yield* Layer.build(
			guestLayer({
				source:
					'\nexport default { automation: { a: { body: (fail) => { if (fail) throw new Error("mapped"); return 1; } } } };\n',
				sourceMap: JSON.stringify({
					version: 3,
					file: 'guest.mjs',
					sources: ['src/automation/+a.automation.ts'],
					names: [],
					mappings: ';AAAA'
				})
			})
		);
		const failed = yield* Context.get(context, Guest).invoke(
			{ ...invocation, input: true },
			noCalls
		);
		expect(failed).toMatchObject({
			kind: 'failed',
			error: { cause: { at: 'src/automation/+a.automation.ts:1' } }
		});
	})
);
it('evaluates guest.mjs as a script: live exports, stubbed imports, an empty import.meta', () => {
	const source = `import { a as b } from 'x';
let c = 1; export { c, f as "g" }; function f() { c++; return typeof b; }
export const meta = import.meta.url;
export default class {}`;
	const ns: unknown = new vm.Script(
		moduleScript(source, (node) => `const ${node.specifiers.map((s) => s.local.name).join()} = 2;`),
		{ lineOffset: -1 }
	).runInContext(vm.createContext());
	expect(ns).toMatchObject({ c: 1, meta: undefined, default: expect.any(Function) });
	expect(Reflect.get(Object(ns), 'g')()).toBe('number');
	expect(ns).toMatchObject({ c: 2 });
	expect(() => moduleScript(`export * from 'x';`, () => '')).toThrow(/re-exports/);
});
