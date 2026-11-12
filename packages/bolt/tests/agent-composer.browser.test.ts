/// <reference types="@vitest/browser-playwright" />
// The composer's queue against a fake host: a message always goes at once and waits in the queue only until the step ends;
// only the timer holds one back, for a time or for when the agent finishes; held messages stay editable and removable.
import { expect, it } from '@effect/vitest';
import { Effect, Layer, ManagedRuntime, Schema } from 'effect';
import { mount_edge } from '@norbital-ai/ui/effect';
import { cdp, page, userEvent } from 'vitest/browser';
import { mount, unmount } from 'svelte';
import Agent from '../src/shell/agent/Agent.svelte';
import { create_bolt } from '../src/page/bolt.ts';
import { QBody, type AgentConversation, type AgentRow } from '../src/protocol/schema.ts';
import { shell_api } from '../src/shell/runtime.ts';
import './support/shell.css';

type Act = { readonly callable: string; readonly input: { readonly [key: string]: unknown } };
type Host = {
	status: AgentConversation['status'];
	rows: AgentRow[];
	acts: Act[];
	forks: { conversation: AgentConversation; rows: AgentRow[] }[];
	post_gate?: Promise<void>;
};
const ID = 'composer';
const conversation = (status: AgentConversation['status'], id = ID): AgentConversation => ({
	id,
	title: 'Composer',
	at: new Date().toISOString(),
	status,
	model: 'default',
	plan: null,
	goals: [],
	envoy: null,
	integration: null,
	kind: null,
	thread: null,
	peer: null
});
const Body = Schema.Struct({
	callable: Schema.String,
	input: Schema.Record(Schema.String, Schema.Unknown)
});
/** The host: answers reads from `host` and applies each act the way the engine does. */
const fake = (host: Host): typeof globalThis.fetch => {
	let seq = 100;
	return async (input, init) => {
		const request = new Request(input, init);
		const path = new URL(request.url).pathname;
		if (path.endsWith('/models'))
			return Response.json({
				value: { models: [{ id: 'default', label: 'Default' }], default: 'default', mcp: [] }
			});
		if (path.endsWith('/act')) {
			const act = Schema.decodeUnknownSync(Body)(await request.json());
			host.acts.push(act);
			const id = `stored-${++seq}`;
			if (act.callable === 'sys_message.restart') {
				const index = host.rows.findIndex((row) => row.id === act.input['message']);
				const selected = host.rows[index];
				if (selected === undefined) throw new Error('Restart requires an existing message');
				host.forks.push({ conversation: conversation('idle', id), rows: host.rows.slice(0, index) });
				return Response.json({ outcome: { kind: 'committed', output: { conversation: id, message: selected, mode: null }, records: [] }, v: 1 });
			}
			if (act.callable === 'sys_message.post') {
				if (host.post_gate !== undefined) await host.post_gate;
				const schedule = act.input['schedule'];
				host.rows.push({
					id,
					seq,
					role: 'user',
					text: String(act.input['text']),
					state:
						schedule !== undefined
							? 'scheduled'
							: host.status === 'running'
								? 'queued'
								: 'consumed',
					tag: typeof schedule === 'string' ? 'scheduled' : null,
					...(typeof act.input['question'] === 'string' ? { answer_to: act.input['question'] } : {}),
					...(typeof schedule === 'string' && schedule !== 'finish' ? { due: schedule } : {})
				});
			}
			if (act.callable === 'sys_message.dequeue')
				host.rows = host.rows.filter((row) => row.id !== act.input['message']);
			if (act.callable === 'sys_message.revise')
				host.rows = host.rows.map((row) =>
					row.id === act.input['message'] ? { ...row, text: String(act.input['text']) } : row
				);
			return Response.json({
				outcome: { kind: 'committed', output: { id }, records: [] },
				v: 1
			});
		}
		const { reads } = Schema.decodeUnknownSync(QBody)(await request.json());
		const read = reads[0];
		if (read?.m === 'conversations')
			return Response.json({ answers: [{ rows: [conversation(host.status), ...host.forks.map((fork) => fork.conversation)] }] });
		const fork = host.forks.find((fork) => fork.conversation.id === read?.a[0]);
		return Response.json({
			answers: [{ rows: fork?.rows ?? host.rows, status: fork === undefined ? host.status : 'idle', inputs: [], outputs: [] }]
		});
	};
};
const withPanel = async (
	start: Partial<Host>,
	check: (host: Host, controls: { target: HTMLElement; refresh: () => Promise<void>; remount: () => Promise<void> }) => Promise<void>,
	request: { readonly prompt?: string; readonly send?: string } = {}
) => {
	const host: Host = { status: 'idle', rows: [], acts: [], forks: [], ...start };
	const previous = { width: innerWidth, height: innerHeight };
	await page.viewport(1100, 800);
	sessionStorage.clear();
	const target = document.createElement('div');
	target.style.cssText = 'height:100dvh';
	document.body.replaceChildren(target);
	const runtime = ManagedRuntime.make(Layer.empty);
	const dispose = mount_edge(runtime);
	try {
		await runtime.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const fetch = fake(host);
					const bolt = yield* create_bolt({
						actor: null,
						operation_outputs: { automations: {} },
						locale: 'en',
						base: location.origin,
						fetch,
						live: 'snapshot'
					});
					yield* Effect.promise(async () => {
						const props = {
							ctx: { ui: { kinds: {} } },
							api: shell_api(fetch, { base: location.origin, after_mutation: () => bolt.refresh() }), bolt,
							t: (key: string) => key, request: { conversation: ID, ...request }
						};
						let view = mount(Agent, { target, props });
						try {
							await expect
								.element(page.getByRole('textbox', { name: 'Message', exact: true }))
								.toBeVisible();
							await check(host, { target, refresh: () => runtime.runPromise(bolt.refresh()), remount: async () => {
								await unmount(view);
								view = mount(Agent, { target, props });
							} });
						} finally {
							await unmount(view);
						}
					});
				})
			)
		);
	} finally {
		await dispose();
		target.remove();
		await page.viewport(previous.width, previous.height);
	}
};
const message = () => page.getByRole('textbox', { name: 'Message', exact: true });
const type = async (text: string) => {
	await message().fill(text);
	await expect.element(page.getByRole('button', { name: 'Schedule message' })).toBeVisible();
};
const openSchedule = () => page.getByRole('button', { name: 'Schedule message' }).click();
const list = (name: 'queue' | 'scheduled') =>
	document.querySelector<HTMLElement>(`[data-agent-${name}]`);

it('a button asking on the person’s behalf sends its words once', async () => {
	await withPanel(
		{},
		async (host) => {
			await expect
				.poll(() => host.acts.filter((act) => act.callable === 'sys_message.post').length)
				.toBe(1);
			expect(host.acts.at(-1)).toMatchObject({ input: { text: 'Fix the conflict' } });
			await expect.element(message()).toHaveValue('');
		},
		{ prompt: 'Fix the conflict', send: 'ask-1' }
	);
});

it('a message sent during a turn goes straight to the queue, never held back', async () => {
	await withPanel({ status: 'running' }, async (host, { refresh }) => {
		await message().fill('steer this');
		await expect.element(page.getByRole('button', { name: 'Send at the next step' })).toBeVisible();
		await userEvent.keyboard('{Enter}');
		await expect.poll(() => list('queue')?.textContent).toContain('steer this');
		expect(host.acts.at(-1)).toMatchObject({
			callable: 'sys_message.post',
			input: { text: 'steer this' }
		});
		expect(host.acts.at(-1)?.input).not.toHaveProperty('schedule');
		// the next step takes it: it leaves the queue for the transcript
		host.rows = host.rows.map((row) => ({ ...row, state: 'consumed' }));
		await refresh();
		await expect.poll(() => list('queue')).toBeNull();
		await expect.element(page.getByText('steer this')).toBeVisible();
	});
});

it('cancels an optimistic queue row before its post answers and dequeues the actual stored message', async () => {
	const pending = Promise.withResolvers<void>();
	await withPanel({ status: 'running', post_gate: pending.promise }, async (host, { target }) => {
		try {
			await message().fill('Cancel before the server answers');
			await userEvent.keyboard('{Enter}');
			await expect.poll(() => target.querySelector('[data-queued]')?.getAttribute('data-queued')).toMatch(/^local:/);
			await page.getByRole('button', { name: 'Remove', exact: true }).click();
			await expect.poll(() => target.querySelector('[data-queued]')).toBeNull();
			pending.resolve();
			await expect.poll(() => host.acts.filter((act) => act.callable === 'sys_message.dequeue')).toHaveLength(1);
			expect(host.acts.at(-1)).toMatchObject({ callable: 'sys_message.dequeue', input: { message: 'stored-101' } });
			await expect.poll(() => host.rows).toEqual([]);
		} finally {
			pending.resolve();
		}
	});
});

it('under a coarse pointer Return is a new line, Send sends, and a queued message moves up by button', async () => {
	const touch = (enabled: boolean) => cdp().send('Emulation.setTouchEmulationEnabled', { enabled });
	await touch(true);
	try {
		await withPanel(
			{
				status: 'running',
				rows: [
					{ id: 'q1', seq: 1, role: 'user', text: 'first', state: 'queued', tag: null },
					{ id: 'q2', seq: 2, role: 'user', text: 'second', state: 'queued', tag: null }
				]
			},
			async (host) => {
				await expect.poll(() => list('queue')?.textContent).toContain('second');
				const up = page.getByRole('button', { name: 'Move up' });
				await expect.element(up.first()).toBeDisabled();
				await up.last().click();
				await expect
					.poll(() => host.acts.at(-1))
					.toMatchObject({
						callable: 'sys_message.reorder',
						input: { messages: ['q2', 'q1'] }
					});
				const acts = host.acts.length;
				await message().fill('steer');
				await userEvent.keyboard('{Enter}');
				await expect.element(message()).toHaveValue('steer\n');
				expect(host.acts).toHaveLength(acts);
				await page.getByRole('button', { name: 'Send at the next step' }).click();
				await expect
					.poll(() => host.acts.at(-1))
					.toMatchObject({
						callable: 'sys_message.post',
						input: { text: 'steer' }
					});
			}
		);
	} finally {
		await touch(false);
	}
});

it('the queue offers no separate steer: every message already steers', async () => {
	await withPanel(
		{
			status: 'running',
			rows: [
				{ id: 'q1', seq: 1, role: 'user', text: 'first', state: 'queued', tag: null },
				{ id: 'q2', seq: 2, role: 'user', text: 'second', state: 'queued', tag: null }
			]
		},
		async () => {
			await expect.poll(() => list('queue')?.textContent).toContain('second');
			await expect.element(page.getByRole('button', { name: 'Steer' })).not.toBeInTheDocument();
		}
	);
});

it('the timer shows only with something to send', async () => {
	await withPanel({}, async () => {
		await expect
			.element(page.getByRole('button', { name: 'Schedule message' }))
			.not.toBeInTheDocument();
		await type('later');
		await message().fill('');
		await expect
			.element(page.getByRole('button', { name: 'Schedule message' }))
			.not.toBeInTheDocument();
	});
});

it('when the agent finishes: offered during a turn, listed, not in the transcript', async () => {
	await withPanel({ status: 'running' }, async (host) => {
		await type('next task');
		await openSchedule();
		await page.getByRole('button', { name: 'When Norbius finishes' }).click();
		await expect.poll(() => list('scheduled')?.textContent).toContain('next task');
		expect(list('scheduled')?.textContent).toContain('When Norbius finishes');
		expect(host.acts.at(-1)?.input).toMatchObject({ text: 'next task', schedule: 'finish' });
		expect(list('queue')).toBeNull();
		expect(document.querySelector('[data-role="user"]')).toBeNull();
	});
});

it('a time: only the future, sent as an instant; nothing to finish when idle', async () => {
	await withPanel({}, async (host) => {
		await type('at noon');
		await openSchedule();
		await expect
			.element(page.getByRole('button', { name: 'When Norbius finishes' }))
			.not.toBeInTheDocument();
		const schedule = page.getByRole('button', { name: 'Schedule', exact: true });
		await expect.element(schedule).toBeDisabled();
		const when = page.getByRole('textbox', { name: 'Send at' });
		await when.fill('2001-01-01T10:00');
		await expect.element(schedule).toBeDisabled();
		const at = new Date(Date.now() + 86_400_000);
		at.setSeconds(0, 0);
		const local = new Date(at.getTime() - at.getTimezoneOffset() * 60_000)
			.toISOString()
			.slice(0, 16);
		await when.fill(local);
		await schedule.click();
		await expect.poll(() => list('scheduled')?.textContent).toContain('at noon');
		expect(host.acts.at(-1)?.input).toMatchObject({ schedule: at.toISOString() });
		await expect.element(message()).toHaveValue('');
	});
});

it('a scheduled message can be edited in place and removed', async () => {
	await withPanel(
		{
			rows: [
				{
					id: 's1',
					seq: 1,
					role: 'user',
					text: 'draft',
					state: 'scheduled',
					tag: 'scheduled',
					due: '2030-01-01T10:00:00.000Z'
				}
			]
		},
		async (host) => {
			await expect.poll(() => list('scheduled')?.textContent).toContain('draft');
			await page.getByRole('button', { name: 'Edit' }).click();
			await expect.element(message()).toHaveValue('draft');
			await expect.element(page.getByText('Editing a queued message.')).toBeVisible();
			await message().fill('final');
			await userEvent.keyboard('{Enter}');
			await expect.poll(() => list('scheduled')?.textContent).toContain('final');
			expect(host.acts.at(-1)).toMatchObject({
				callable: 'sys_message.revise',
				input: { message: 's1', text: 'final' }
			});
			await page.getByRole('button', { name: 'Remove' }).click();
			await expect.poll(() => list('scheduled')).toBeNull();
			expect(host.acts.at(-1)).toMatchObject({
				callable: 'sys_message.dequeue',
				input: { message: 's1' }
			});
		}
	);
});

it('a message the throttle is reading says so and can be answered now', async () => {
	await withPanel(
		{
			rows: [
				{ id: 'p1', seq: 1, role: 'user', text: 'What are u doing', state: 'pending', tag: null }
			]
		},
		async (host) => {
			await expect.element(page.getByText('reading…')).toBeVisible();
			await expect.element(page.getByText('waiting for more')).not.toBeInTheDocument();
			await page.getByRole('button', { name: 'Respond now' }).click();
			await expect.poll(() => host.acts.at(-1)?.callable).toBe('sys_conversation.respond_now');
		}
	);
});


it('keeps an unsent draft when the chat is closed and reopened', async () => {
	await withPanel({}, async (host, { remount }) => {
		await message().fill('Keep this while I inspect the workspace');
		await remount();
		await expect.element(message()).toHaveValue('Keep this while I inspect the workspace');
		expect(host.acts).toEqual([]);
	});
});

it('restarts from any earlier message in a new chat and leaves the original intact', async () => {
	const rows: AgentRow[] = [
		{ id: 'first', seq: 1, role: 'user', text: 'Earlier request', state: 'consumed', tag: null },
		{ id: 'answer', seq: 2, role: 'assistant', text: 'Earlier answer', state: null, tag: 'reply' },
		{ id: 'last', seq: 3, role: 'user', text: 'Most recent request', state: 'consumed', tag: null }
	];
	await withPanel({ rows }, async (host) => {
		const restart = page.getByRole('button', { name: 'Restart in a new chat from this message', exact: true });
		await expect.poll(() => document.querySelectorAll('[aria-label="Restart in a new chat from this message"]').length).toBe(2);
		await restart.first().click();
		await expect.element(message()).toHaveValue('Earlier request');
		expect(host.acts.at(-1)).toMatchObject({ callable: 'sys_message.restart', input: { message: 'first' } });
		expect(host.rows).toEqual(rows);
		expect(host.forks).toHaveLength(1);
		expect(host.forks[0]?.rows).toEqual([]);
		expect(host.acts.filter((act) => act.callable === 'sys_message.post')).toEqual([]);
	});
});

it('opens at the live tail, stays latched, and detaches until Latest is pressed', async () => {
	const rows: AgentRow[] = Array.from({ length: 96 }, (_, index) => ({
		id: `reply-${index}`, seq: index + 1, role: 'assistant',
		text: `Reply ${index}: ${'A substantial transcript line. '.repeat(12)}`, state: null, tag: 'reply'
	}));
	await withPanel({ status: 'running', rows }, async (host, { target, refresh, remount }) => {
		const transcript = () => {
			const node = target.querySelector<HTMLElement>('[data-agent-transcript]');
			if (node === null) throw new Error('Missing transcript viewport');
			return node;
		};
		await expect.poll(() => transcript().scrollHeight > transcript().clientHeight).toBe(true);
		expect(Math.abs(transcript().scrollTop)).toBeLessThanOrEqual(1);
		await remount();
		await expect.poll(() => transcript().scrollHeight > transcript().clientHeight).toBe(true);
		expect(Math.abs(transcript().scrollTop)).toBeLessThanOrEqual(1);
		host.rows.push({ id: 'live-tail', seq: 97, role: 'assistant', text: 'Newest live reply', state: 'streaming', tag: 'reply' });
		await refresh();
		await expect.element(page.getByText('Newest live reply', { exact: true })).toBeVisible();
		expect(Math.abs(transcript().scrollTop)).toBeLessThanOrEqual(1);
		const tail = host.rows.find((row) => row.id === 'live-tail');
		if (tail === undefined) throw new Error('Missing streaming tail row');
		const streamed = Array.from({ length: 24 }, (_, index) => `Streamed paragraph ${index + 1}: ${'Streaming detail. '.repeat(8)}`);
		host.rows = host.rows.map((row) => row === tail ? { ...row, text: ['Newest live reply', ...streamed, 'Tail remains visible'].join('\n\n') } : row);
		await refresh();
		await expect.element(page.getByText('Tail remains visible', { exact: true })).toBeVisible();
		expect(Math.abs(transcript().scrollTop)).toBeLessThanOrEqual(1);
		expect(target.querySelectorAll('[data-role="assistant"]').length).toBeLessThan(96);
		transcript().scrollTop = -300;
		transcript().dispatchEvent(new Event('scroll'));
		await expect.element(page.getByRole('button', { name: 'Jump to latest', exact: true })).toBeVisible();
		const viewport = transcript().getBoundingClientRect();
		const anchor = [...transcript().querySelectorAll('p')].find((node) => {
			const box = node.getBoundingClientRect();
			return box.top >= viewport.top && box.bottom <= viewport.bottom;
		});
		if (anchor === undefined) throw new Error('Missing visible detached transcript anchor');
		const anchor_top = anchor.getBoundingClientRect().top;
		host.rows.push({ id: 'detached-tail', seq: 98, role: 'assistant', text: 'Reply while detached', state: null, tag: 'reply' });
		await refresh();
		await expect.poll(() => target.textContent).toContain('Reply while detached');
		expect(transcript().scrollTop).toBeLessThan(-100);
		expect(Math.abs(anchor.getBoundingClientRect().top - anchor_top)).toBeLessThanOrEqual(1);
		host.rows = host.rows.map((row) => row.id === 'detached-tail' ? { ...row, text: `Reply while detached\n\n${'Another streamed sentence. '.repeat(100)}\n\nDetached tail complete` } : row);
		await refresh();
		await expect.poll(() => Math.abs(anchor.getBoundingClientRect().top - anchor_top)).toBeLessThanOrEqual(1);
		await page.getByRole('button', { name: 'Jump to latest', exact: true }).click();
		await expect.poll(() => Math.abs(transcript().scrollTop)).toBeLessThanOrEqual(1);
		await expect.element(page.getByText('Detached tail complete', { exact: true })).toBeVisible();
		await expect.element(page.getByRole('button', { name: 'Jump to latest', exact: true })).not.toBeInTheDocument();
	});
});


it('keeps a long question bounded with one readable region and a reachable answer action', async () => {
	const options = Array.from({ length: 28 }, (_, index) => `Choice ${index + 1}: ${'A considered alternative. '.repeat(5)}`);
	await withPanel({ rows: [{ id: 'question-1', seq: 1, role: 'assistant', text: null, state: null, tag: 'reply', asked: true,
		question: { question: 'Which option would you like?', options } }] }, async (host, { target }) => {
		const send = page.getByRole('button', { name: 'Send answer', exact: true });
		await expect.element(send).toBeVisible();
		const card = target.querySelector<HTMLElement>('[data-question="question-1"]');
		const details = target.querySelector<HTMLElement>('[data-question-details]');
		if (card === null || details === null) throw new Error('Missing question card');
		await expect.poll(() => details.scrollHeight > details.clientHeight).toBe(true);
		expect(details.tabIndex).toBe(0);
		details.focus();
		expect(document.activeElement).toBe(details);
		const scroll_top = details.scrollTop;
		await userEvent.keyboard('{PageDown}');
		await expect.poll(() => details.scrollTop).toBeGreaterThan(scroll_top);
		expect(card.getBoundingClientRect().height).toBeLessThanOrEqual(innerHeight * 0.6 + 1);
		expect(target.querySelectorAll('[data-question-details]')).toHaveLength(1);
		await page.getByRole('radio', { name: /Choice 28:/ }).click();
		await expect.element(send).toBeVisible();
		const button = send.element().getBoundingClientRect();
		const bound = card.getBoundingClientRect();
		expect(button.top).toBeGreaterThanOrEqual(bound.top);
		expect(button.bottom).toBeLessThanOrEqual(bound.bottom);
		await send.click();
		await expect.poll(() => host.acts.filter((act) => act.callable === 'sys_message.post')).toHaveLength(1);
		expect(host.acts.at(-1)).toMatchObject({ callable: 'sys_message.post', input: { question: 'question-1', text: options[27], now: true } });
		await expect.element(page.getByText('Answered', { exact: true })).toBeVisible();
	});
});
