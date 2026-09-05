import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit, Fiber, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { Prompt } from 'effect/unstable/ai';
import { toError } from '@norbital-ai/std';
import { vi } from 'vitest';
import { createAgentClient } from '../src/client/ui/agent/client.svelte.js';
import {
	COMPOSER_ADMISSION_TIMEOUT_MESSAGE,
	COMPOSER_COMMAND_DEADLINE,
	runComposerCommand
} from '../src/client/ui/agent/composer-send.js';
import { encodeUserMessageWithImages } from '../src/runtime/agents/image-descriptors.js';
import { emptyAgentClient } from './ui-agent-client-fixture.js';

const TASK_ID = '00000000-0000-4000-8000-000000000301';
const DIRECTIVE_ID = '00000000-0000-4000-8000-000000000302';
const HEADED_TEXT = 'How many companies are in this HR workspace?';

const subject = {
	userId: 'admin-1',
	tenantId: 'tenant-1',
	teamPath: ['admin'],
	policies: []
} as const;

describe('G1 Task composer submit', () => {
	it('posts tasks.submit for a text-only headed message', async () => {
		const calls: Array<{ readonly command: string; readonly input: unknown }> = [];
		const command = vi.fn((name: string, input: unknown) => {
			calls.push({ command: name, input });
			return Promise.resolve({ directiveId: DIRECTIVE_ID });
		});
		const agent = createAgentClient({
			client: emptyAgentClient({ command }),
			subject,
			agentId: 'web'
		});
		const draft = { text: HEADED_TEXT, cleared: false };
		let sendFailure: string | null = null;
		let pending = true;

		const exit = await Effect.runPromiseExit(
			runComposerCommand(
				encodeUserMessageWithImages(HEADED_TEXT, []).pipe(
					Effect.flatMap((message) =>
						agent.submit({
							taskId: TASK_ID,
							message,
							mode: 'agent',
							priority: 'normal',
							modelId: 'openrouter/provider/selected'
						})
					)
				),
				{
					onSuccess: () => {
						draft.cleared = true;
					},
					onFailure: (failure) => {
						sendFailure = failure;
					},
					onSettled: () => {
						pending = false;
					}
				}
			)
		);

		expect(Exit.isSuccess(exit)).toBe(true);
		expect(sendFailure).toBeNull();
		expect(pending).toBe(false);
		expect(draft.cleared).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.command).toBe('tasks.submit');
		expect(calls[0]?.input).toMatchObject({
			taskId: TASK_ID,
			agentId: 'web',
			message: { role: 'user', content: HEADED_TEXT },
			mode: 'agent',
			priority: 'normal',
			modelId: 'openrouter/provider/selected'
		});
	});

	it('surfaces a string-content encode throw on sendFailure and keeps the draft', async () => {
		const calls: Array<{ readonly command: string }> = [];
		const command = vi.fn((name: string) => {
			calls.push({ command: name });
			return Promise.resolve({ directiveId: DIRECTIVE_ID });
		});
		const agent = createAgentClient({
			client: emptyAgentClient({ command }),
			subject,
			agentId: 'web'
		});
		const draft = { text: HEADED_TEXT, cleared: false };
		let sendFailure: string | null = null;
		let pending = true;

		const exit = await Effect.runPromiseExit(
			runComposerCommand(
				Effect.try({
					try: () =>
						Schema.encodeSync(Prompt.Message)(
							Prompt.userMessage({ content: HEADED_TEXT as never })
						),
					catch: toError
				}).pipe(
					Effect.flatMap((message) =>
						agent.submit({
							taskId: TASK_ID,
							message,
							mode: 'agent',
							priority: 'normal'
						})
					)
				),
				{
					onSuccess: () => {
						draft.cleared = true;
					},
					onFailure: (failure) => {
						sendFailure = failure;
					},
					onSettled: () => {
						pending = false;
					}
				}
			)
		);

		expect(Exit.isFailure(exit)).toBe(true);
		expect(sendFailure).toMatch(/content|array/i);
		expect(pending).toBe(false);
		expect(draft.cleared).toBe(false);
		expect(draft.text).toBe(HEADED_TEXT);
		expect(calls).toEqual([]);
	});

	it('keeps the draft and paints sendFailure when tasks.submit is refused', async () => {
		const command = vi.fn(() => Promise.reject(new Error('The Task could not be admitted.')));
		const agent = createAgentClient({
			client: emptyAgentClient({ command }),
			subject,
			agentId: 'web'
		});
		const draft = { text: HEADED_TEXT, cleared: false };
		let sendFailure: string | null = null;
		let pending = true;

		const exit = await Effect.runPromiseExit(
			runComposerCommand(
				encodeUserMessageWithImages(HEADED_TEXT, []).pipe(
					Effect.flatMap((message) =>
						agent.submit({
							taskId: TASK_ID,
							message,
							mode: 'agent',
							priority: 'normal'
						})
					)
				),
				{
					onSuccess: () => {
						draft.cleared = true;
					},
					onFailure: (failure) => {
						sendFailure = failure;
					},
					onSettled: () => {
						pending = false;
					}
				}
			)
		);

		expect(Exit.isFailure(exit)).toBe(true);
		expect(sendFailure).toBe('The Task could not be admitted.');
		expect(pending).toBe(false);
		expect(draft.cleared).toBe(false);
		expect(command).toHaveBeenCalledTimes(1);
	});

	it.effect('does not fail at 4s and paints sendFailure at the 5s admit wall', () =>
		Effect.gen(function* () {
			const draft = { text: HEADED_TEXT, cleared: false };
			let sendFailure: string | null = null;
			let pending = true;
			const fiber = yield* runComposerCommand(Effect.never, {
				onSuccess: () => {
					draft.cleared = true;
				},
				onFailure: (failure) => {
					sendFailure = failure;
				},
				onSettled: () => {
					pending = false;
				}
			}).pipe(Effect.forkChild);
			yield* TestClock.adjust('4 seconds');
			expect(sendFailure).toBeNull();
			expect(pending).toBe(true);
			expect(draft.cleared).toBe(false);
			yield* TestClock.adjust('1 second');
			const exit = yield* Fiber.await(fiber);
			expect(Exit.isFailure(exit)).toBe(true);
			expect(sendFailure).toBe(COMPOSER_ADMISSION_TIMEOUT_MESSAGE);
			expect(pending).toBe(false);
			expect(draft.cleared).toBe(false);
			expect(draft.text).toBe(HEADED_TEXT);
		})
	);

	it.effect('paints sendFailure when tasks.submit never returns', () =>
		Effect.gen(function* () {
			const signals: Array<AbortSignal | undefined> = [];
			const command = vi.fn((_name: string, _input: unknown, signal?: AbortSignal) => {
				signals.push(signal);
				return new Promise(() => undefined);
			});
			const agent = createAgentClient({
				client: emptyAgentClient({ command }),
				subject,
				agentId: 'web'
			});
			const draft = { text: HEADED_TEXT, cleared: false };
			let sendFailure: string | null = null;
			let pending = true;
			const fiber = yield* runComposerCommand(
				encodeUserMessageWithImages(HEADED_TEXT, []).pipe(
					Effect.flatMap((message) =>
						agent.submit({
							taskId: TASK_ID,
							message,
							mode: 'agent',
							priority: 'normal'
						})
					)
				),
				{
					onSuccess: () => {
						draft.cleared = true;
					},
					onFailure: (failure) => {
						sendFailure = failure;
					},
					onSettled: () => {
						pending = false;
					}
				},
				COMPOSER_COMMAND_DEADLINE
			).pipe(Effect.forkChild);
			yield* TestClock.adjust(COMPOSER_COMMAND_DEADLINE);
			const exit = yield* Fiber.await(fiber);
			expect(Exit.isFailure(exit)).toBe(true);
			expect(sendFailure).toBe(COMPOSER_ADMISSION_TIMEOUT_MESSAGE);
			expect(pending).toBe(false);
			expect(draft.cleared).toBe(false);
			expect(draft.text).toBe(HEADED_TEXT);
			expect(command).toHaveBeenCalledTimes(1);
			expect(signals[0]).toBeInstanceOf(AbortSignal);
		})
	);
});
