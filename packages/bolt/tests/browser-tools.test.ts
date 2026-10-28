// The built-in browser tools drive the host's browsing facility; without one, every call says what is missing.
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import type { Downloaded, EngineActor } from '../src/engine/contracts.ts';
import { Browser } from '../src/engine/ports.ts';
import { off } from '../src/facilities/index.ts';
import { BROWSER_RUN_PROFILE, browserTools } from '../src/engine/agent/browser.ts';
import type { HostTool } from '../src/engine/agent/tools.ts';

const call = (
	tool: HostTool | undefined,
	input: Parameters<HostTool['call']>[0],
	actor: EngineActor
) =>
	Effect.promise((signal) =>
		tool === undefined
			? Promise.reject(new Error('no such tool'))
			: tool.call(
					input,
					{ actor, conversation: 'r1', turn: 'r1', callId: 'c1', attach: () => {} },
					signal
				)
	);
const run: EngineActor = { kind: 'system', run: 'r1', by: { automation: 'drift' } };

describe('built-in browser tools', () => {
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
			const download = browserTools(yield* Browser.pipe(Effect.provide(browser))).find(
				(tool) => tool.name === 'browser_download'
			);
			const kept: Downloaded[] = [];
			const answer = yield* Effect.promise((signal) =>
				download === undefined
					? Promise.reject(new Error('no such tool'))
					: download.call(
							{ url: 'https://law.example/seal.png' },
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
			expect(yield* call(download, { url: 'https://law.example/seal.png' }, run)).toEqual({
				error: 'files are kept only in a conversation with a person'
			});
		})
	);
});
