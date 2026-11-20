import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { node_guests } from '../src/node/guests.ts';

/**
 * Minimal prelude that exposes the four host bridges (`$0`..`$3`) to the guest module under test
 * and returns the module's `run()` JSON result through `take()`.
 */
const HARNESS_PRELUDE = `
	let final = null;
	globalThis.__bridges = [$0, $1, $2, $3];
	return {
		start() {
			const out = globalThis.__boltGuest.run();
			final = ['ok', JSON.stringify(out)];
		},
		take() {
			return [final, [], [], false];
		},
		give() {}
	};
`;

const runGuest = async (source: string, assets?: Readonly<Record<string, Uint8Array>>) => {
	const guests = node_guests();
	const controller = new AbortController();
	const id = await guests.open(
		assets === undefined ? { source } : { source, assets },
		{ prelude: HARNESS_PRELUDE, seed: 'hardening-seed', memory_mib: 32 },
		controller.signal
	);
	try {
		return await guests.start(
			id,
			{ kind: 'test', path: ['run'], input: '{}', ctx: '{}', invocation: 'inv-1' },
			controller.signal
		);
	} finally {
		await guests.close(id);
	}
};

describe('node_guests vm membrane hardening', () => {
	it('blocks host Function escape via bridge.constructor.constructor, return values, thrown errors, and turn trampoline', async () => {
		const payload = new Uint8Array([10, 20, 30, 40]);
		const source = `
			const probe = (fn) => {
				try {
					const leaked = fn();
					return leaked !== undefined ? 'ESCAPED:' + typeof leaked : 'undefined';
				} catch (err) {
					return 'BLOCKED:' + (err instanceof Error ? err.name : typeof err);
				}
			};

			export function run() {
				const [$0, $1, $2, $3] = globalThis.__bridges;
				const results = {};

				// 1. Direct host Function constructor probes on all 4 bridge functions
				results.sayCtor = probe(() => $0.constructor.constructor('return process')());
				results.randomCtor = probe(() => $1.constructor.constructor('return process')());
				results.digestCtor = probe(() => $2.constructor.constructor('return process')());
				results.assetCtor = probe(() => $3.constructor.constructor('return process')());
				results.protoCtor = probe(() => Object.getPrototypeOf($1).constructor('return process')());

				// 2. Return value & ArrayBuffer prototype probes
				const rand = $1(16);
				const hashed = $2('SHA-256', new Uint8Array([10, 20, 30, 40]));
				const asset = $3('asset-1');
				results.randInstanceof = rand instanceof Uint8Array;
				results.hashInstanceof = hashed instanceof Uint8Array;
				results.assetInstanceof = asset instanceof Uint8Array;
				results.randCtor = probe(() => rand.constructor.constructor('return process')());
				results.randBufCtor = probe(() => rand.buffer.constructor.constructor('return process')());
				results.hashBufCtor = probe(() => hashed.buffer.constructor.constructor('return process')());
				results.assetBufCtor = probe(() => asset.buffer.constructor.constructor('return process')());

				// 3. Thrown error prototype probes across host hook failures
				results.randomErrCtor = probe(() => {
					try {
						$1(-1);
					} catch (e) {
						if (!(e instanceof Error)) return 'HOST_ERROR_PROTO';
						return e.constructor.constructor('return process')();
					}
				});
				results.digestAlgoErrCtor = probe(() => {
					try {
						$2('MD5', new Uint8Array([1]));
					} catch (e) {
						if (!(e instanceof Error)) return 'HOST_ERROR_PROTO';
						return Object.getPrototypeOf(e).constructor.constructor('return process')();
					}
				});
				results.digestBadArgErrCtor = probe(() => {
					try {
						$2({ toString() { return 'SHA-256'; } }, new Proxy(new Uint8Array([1]), {}));
					} catch (e) {
						if (!(e instanceof Error)) return 'HOST_ERROR_PROTO';
						return e.constructor.constructor('return process')();
					}
				});

				// 4. Turn trampoline and globalThis probes
				results.turnCtor = probe(() =>
					globalThis[Symbol.for('norbital.bolt.turn')].constructor.constructor('return process')()
				);
				results.turnStringAbsent = !Object.getOwnPropertyNames(globalThis).includes('__norbital_bolt_turn__');
				results.globalCtor = probe(() => globalThis.constructor.constructor('return process')());

				// 5. Prototype iterator tampering still allows legitimate bridge calls safely
				Array.prototype[Symbol.iterator] = function () {
					throw new Error('tampered iterator');
				};
				$0('info', 'hardened-log');
				results.hashHex = Array.from(hashed, (b) => b.toString(16).padStart(2, '0')).join('');
				results.assetBytes = Array.from(asset);
				return results;
			}
		`;

		const turn = await runGuest(source, { 'asset-1': payload });
		expect(turn.taken[0]?.[0]).toBe('ok');
		const parsed = JSON.parse(turn.taken[0]?.[1] ?? '{}');

		for (const key of [
			'sayCtor',
			'randomCtor',
			'digestCtor',
			'assetCtor',
			'protoCtor',
			'randCtor',
			'randBufCtor',
			'hashBufCtor',
			'assetBufCtor',
			'randomErrCtor',
			'digestAlgoErrCtor',
			'digestBadArgErrCtor',
			'turnCtor',
			'globalCtor'
		]) {
			expect(parsed[key]).toBe('BLOCKED:ReferenceError');
		}
		expect(parsed.randInstanceof).toBe(true);
		expect(parsed.hashInstanceof).toBe(true);
		expect(parsed.assetInstanceof).toBe(true);
		expect(parsed.turnStringAbsent).toBe(true);
		expect(parsed.hashHex).toBe(createHash('sha256').update(payload).digest('hex'));
		expect(parsed.assetBytes).toEqual([10, 20, 30, 40]);
		expect(turn.lines).toEqual([['info', 'hardened-log']]);
	});
});
