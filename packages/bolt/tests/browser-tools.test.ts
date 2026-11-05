// The built-in browser tools drive the host's browsing facility; without one, every call says what is missing.
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import type { BrowserPort, Downloaded, EngineActor } from '../src/engine/contracts.ts';
import { Browser } from '../src/engine/ports.ts';
import { off } from '../src/facilities/index.ts';
import { BROWSER_RUN_PROFILE, browserProfile, browserTools } from '../src/engine/agent/browser.ts';
import type { HostTool } from '../src/engine/agent/tools.ts';

const call = (
	tool: HostTool | undefined,
	input: Parameters<HostTool['call']>[0],
	actor: EngineActor,
	attached: Uint8Array[] = []
) =>
	Effect.promise((signal) =>
		tool === undefined
			? Promise.reject(new Error('no such tool'))
			: tool.call(
					input,
					{
						actor,
						conversation: 'r1',
						turn: 'r1',
						callId: 'c1',
						attach: (file) => attached.push(file.bytes)
					},
					signal
				)
	);
const run: EngineActor = { kind: 'system', run: 'r1', by: { automation: 'drift' } };
const member: EngineActor = {
	kind: 'member',
	id: 'm1',
	email: null,
	phone: null,
	external: false,
	teams: [],
	teamPath: [],
	admin: false,
	party: null
};

describe('built-in browser tools', () => {
	it('keeps one browser identity per person and one tab per conversation', () => {
		expect(browserProfile(member, 'c1')).toBe('person:m1\u0000c1');
		expect(browserProfile(run, 'r1')).toBe(`${BROWSER_RUN_PROFILE}r1`);
		expect(browserProfile({ kind: 'visitor', app: 'a', visitor: 'v' }, 'c1')).toBeUndefined();
	});
	it.effect('offers one browser tool for a whole visit', () =>
		Effect.gen(function* () {
			expect(browserTools(yield* Browser).map((tool) => tool.name)).toEqual(['browser']);
		}).pipe(Effect.provide(Browser.fromAbi(off)))
	);
	it.effect('opens a workspace page in the same browser and attaches its screenshot', () =>
		Effect.gen(function* () {
			const seen: unknown[] = [],
				attached: Uint8Array[] = [],
				browser = Layer.succeed(Browser, {
					navigate: () => Effect.succeed({}),
					scoped: () => Effect.die('unused scoped'),
					openWorkspace: (profile, target, caller) =>
						Effect.sync(() => {
							seen.push({ profile, target, caller });
							return { url: 'https://live.test/app/x', page: 'ok' };
						}),
					snapshot: () => Effect.succeed(null),
					act: () => Effect.succeed(null),
					evaluate: () => Effect.succeed(null),
					screenshot: () => Effect.succeed(new Uint8Array([1])),
					download: () => Effect.die('unused download')
				}),
				[visit] = browserTools(yield* Browser.pipe(Effect.provide(browser)));
			const answer = yield* call(
				visit,
				{ workspace: { environment: 'live', path: '/app/x' } },
				member,
				attached
			);
			expect(answer).toEqual({ url: 'https://live.test/app/x', page: 'ok' });
			expect(seen).toEqual([
				{
					profile: 'person:m1\u0000r1',
					target: { environment: 'live', path: '/app/x' },
					caller: { actor: member, conversation: 'r1' }
				}
			]);
			expect(attached).toHaveLength(1);
		})
	);
	it.effect('closes the tab when its scope ends, and only then', () =>
		Effect.gen(function* () {
			let closed = 0;
			const port: BrowserPort = {
				navigate: async () => ({ url: 'https://a.test/' }),
				snapshot: async () => null,
				act: async () => null,
				evaluate: async () => null,
				screenshot: async () => new Uint8Array(),
				download: async () => {
					throw new Error('unused download');
				},
				close: async () => {
					closed += 1;
				}
			};
			yield* Effect.scoped(
				Effect.gen(function* () {
					const browser = yield* Browser;
					const session = yield* browser.scoped('person:1\\u0000c1');
					yield* session.navigate({ url: 'https://a.test/' });
					expect(closed).toBe(0);
				})
			).pipe(Effect.provide(Browser.fromAbi(port)));
			expect(closed).toBe(1);
		})
	);
	it.effect('closes its tab through browser { close }', () =>
		Effect.gen(function* () {
			let closed = 0;
			const browser = Layer.succeed(Browser, {
				navigate: () => Effect.succeed({}),
				scoped: () => Effect.die('unused scoped'),
				snapshot: () => Effect.succeed(null),
				act: () => Effect.succeed(null),
				evaluate: () => Effect.succeed(null),
				screenshot: () => Effect.succeed(new Uint8Array()),
				close: () =>
					Effect.sync(() => {
						closed += 1;
					}),
				download: () => Effect.die('unused download')
			});
			const [visit] = browserTools(yield* Browser.pipe(Effect.provide(browser)));
			expect(yield* call(visit, { close: true }, member)).toEqual({ closed: true });
			expect(closed).toBe(1);
		})
	);
	it.effect('answer that the host supplies no browser facility', () =>
		Effect.gen(function* () {
			const [navigate] = browserTools(yield* Browser);
			expect(yield* call(navigate, { url: 'https://law.example' }, run)).toEqual({
				error: 'the host turned this facility off'
			});
		}).pipe(Effect.provide(Browser.fromAbi(off)))
	);
	it.effect('browse an automation run in its own profile, and refuse a visitor', () =>
		Effect.gen(function* () {
			const opened: string[] = [];
			const browser = Layer.succeed(Browser, {
				navigate: (profile) =>
					Effect.sync(() => (opened.push(profile), { url: 'https://law.example' })),
				scoped: () => Effect.die('unused scoped'),
				snapshot: () => Effect.succeed(null),
				act: () => Effect.succeed(null),
				evaluate: () => Effect.succeed(null),
				screenshot: () => Effect.succeed(new Uint8Array()),
				download: () => Effect.die('unused download')
			});
			const [navigate] = browserTools(yield* Browser.pipe(Effect.provide(browser)));
			yield* call(navigate, { url: 'https://law.example' }, run);
			expect(opened).toEqual([`${BROWSER_RUN_PROFILE}r1`]);
			expect(
				yield* call(
					navigate,
					{ url: 'https://law.example' },
					{ kind: 'visitor', app: 'a', visitor: 'v' }
				)
			).toEqual({ error: 'only a person or an automation run can browse' });
		})
	);
	it.effect("keep a download as the person's file, and answer that a run keeps none", () =>
		Effect.gen(function* () {
			const none = () => Effect.succeed(null);
			const browser = Layer.succeed(Browser, {
				navigate: none,
				scoped: () => Effect.die('unused scoped'),
				snapshot: none,
				act: none,
				evaluate: none,
				screenshot: () => Effect.succeed(new Uint8Array()),
				download: (_profile, url) =>
					Effect.succeed({
						key: 'k',
						sha256: 's',
						name: url.split('/').at(-1) ?? '',
						mime: 'image/png',
						bytes: 3
					})
			});
			const [visit] = browserTools(yield* Browser.pipe(Effect.provide(browser)));
			const kept: Downloaded[] = [];
			const answer = yield* Effect.promise((signal) =>
				visit === undefined
					? Promise.reject(new Error('no such tool'))
					: visit.call(
							{ download: 'https://law.example/seal.png' },
							{
								actor: run,
								conversation: 'c1',
								turn: 't1',
								callId: 'c1',
								attach: () => {},
								keep: (file) => kept.push(file)
							},
							signal
						)
			);
			expect(answer).toEqual({ saved: 'seal.png', mime: 'image/png', bytes: 3 });
			expect(kept.map((file) => file.name)).toEqual(['seal.png']);
			expect(yield* call(visit, { download: 'https://law.example/seal.png' }, run)).toEqual({
				error: 'files are kept only in a conversation with a person'
			});
		})
	);
});
