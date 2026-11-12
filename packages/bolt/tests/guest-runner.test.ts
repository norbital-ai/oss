// Mutations: dropping final[4] loses timeout retry classification.
import { expect, it } from '@effect/vitest';
import { Context, Effect, Layer } from 'effect';
import { LIMITS, type CrossAnswer, type Invocation } from '../src/engine/contracts.ts';
import { Guest, GuestLimits, type Bridge, type CrossCall } from '../src/engine/services.ts';
import { guest_layer } from './support/guest-fixture.ts';
import vm from 'node:vm';
import { module_script } from '../src/node/guest-hooks.ts';
import { node_guests } from '../../bolt-cli/src/guests.ts';
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

it('validates foreign prelude callbacks and their returned turn tuples', async () => {
	const port = node_guests();
	const signal = new AbortController().signal;
	const options = { seed: 'foreign-prelude', memory_mib: 64 };
	await expect(port.open({ source: 'export default {};' }, {
		...options,
		prelude: 'return { start: 7, take() { return [null, [], [], false]; }, give() {} };'
	}, signal)).rejects.toThrow();
	const session = await port.open({ source: 'export default {};' }, {
		...options,
		prelude: 'return { start() {}, take() { return [["ok", 7], [], [], false]; }, give() {} };'
	}, signal);
	try {
		await expect(port.take(session, signal)).rejects.toThrow();
		await expect(port.take(session, signal)).rejects.toThrow('the guest session is closed');
	} finally {
		await port.close(session);
	}
});

it.live(
	'write transforms can return a change set larger than call arguments, within its own bound',
	() =>
		Effect.gen(function* () {
			const invoke = (kind: 'create' | 'automation', changeSetBytes: number) =>
				Effect.gen(function* () {
					const context = yield* Layer.build(
						guest_layer({
							source:
								'export default { model: { a: { bodies: { create: () => [{ note: "x".repeat(128) }] } } }, automation: { a: { body: () => "x".repeat(128) } } };'
						}).pipe(
							Layer.provide(
								Layer.succeed(GuestLimits, {
									memory_mib: LIMITS.guestMemoryMiB,
									crossings: LIMITS.crossings,
									read_bytes: LIMITS.readBytes,
									crossing_bytes: LIMITS.crossingBytes,
									args_bytes: 64,
									change_set_bytes: changeSetBytes
								})
							)
						)
					);
					return yield* Context.get(context, Guest).invoke({ ...invocation, kind }, noCalls);
				});
			expect(yield* invoke('create', 256)).toMatchObject({
				kind: 'ok',
				output: [{ note: 'x'.repeat(128) }]
			});
			expect(yield* invoke('create', 64)).toMatchObject({
				kind: 'failed',
				error: { code: 'too_large' }
			});
			expect(yield* invoke('automation', 256)).toMatchObject({
				kind: 'failed',
				error: { code: 'too_large' }
			});
		})
);
it.live('copies facility failure kind onto the guest error cause', () =>
	Effect.gen(function* () {
		const context = yield* Layer.build(
			guest_layer({
				source:
					'export default { automation: { a: { body: () => { const e = new Error("slow"); e.kind = "timeout"; throw e; } } } };'
			})
		);
		const answer = yield* Context.get(context, Guest).invoke(invocation, noCalls);
		expect(answer).toMatchObject({
			kind: 'failed',
			error: { code: 'guest_error', cause: { kind: 'timeout', message: 'slow' } }
		});
	})
);
it.live('identifies an oversized atomic write-map response through its current operation', () =>
	Effect.gen(function* () {
		const context = yield* Layer.build(guest_layer({
			source: `export default { automation: { a: { body: async () => globalThis[Symbol.for('norbital.bolt.call')]('act', [{ 'a.create': [] }]) } } };`
		}).pipe(Layer.provide(Layer.succeed(GuestLimits, {
			memory_mib: LIMITS.guestMemoryMiB,
			crossings: LIMITS.crossings,
			read_bytes: LIMITS.readBytes,
			crossing_bytes: 64,
			args_bytes: 1024,
			change_set_bytes: 1024
		}))));
		const calls: CrossCall[] = [];
		const bridge: Bridge = {
			cross: (batch) => Effect.sync(() => {
				calls.push(...batch);
				return batch.map((): CrossAnswer => ({
					ok: true,
					value: { kind: 'committed', output: { 'a.create': 'x'.repeat(256) }, records: [] }
				}));
			})
		};
		const outcome = yield* Context.get(context, Guest).invoke(invocation, bridge);
		expect(calls).toMatchObject([{
			_tag: 'act', acts: [{ model: 'a', verb: 'create', input: [] }], outputs: ['a.create']
		}]);
		expect(outcome).toMatchObject({ kind: 'failed', error: {
			code: 'too_large', message: expect.stringContaining('Could not complete ctx.act:')
		} });
	})
);
it.live('maps a guest error to its authored location', () =>
	Effect.gen(function* () {
		const context = yield* Layer.build(
			guest_layer({
				source:
					'\nexport default { automation: { a: { body: (fail) => { if (fail) throw new Error("mapped"); return 1; } } } };\n',
				source_map: JSON.stringify({
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
		module_script(source, (node) => `const ${node.specifiers.map((s) => s.local.name).join()} = 2;`),
		{ lineOffset: -1 }
	).runInContext(vm.createContext());
	expect(ns).toMatchObject({ c: 1, meta: undefined, default: expect.any(Function) });
	expect(Reflect.get(Object(ns), 'g')()).toBe('number');
	expect(ns).toMatchObject({ c: 2 });
	expect(() => module_script(`export * from 'x';`, () => '')).toThrow(/re-exports/);
});
