/// <reference types="@vitest/browser-playwright" />
// The composer's queue against a fake host: a message always goes at once and waits in the queue only until the step ends;
// only the timer holds one back, for a time or for when the agent finishes; held messages stay editable and removable.
import { expect, it } from '@effect/vitest';
import { Effect, Layer, ManagedRuntime, Schema } from 'effect';
import { mountEdge } from '@norbital-ai/ui/effect';
import { page, userEvent } from 'vitest/browser';
import { mount, unmount } from 'svelte';
import Agent from '../src/shell/agent/Agent.svelte';
import { createBolt } from '../src/page/bolt.ts';
import { QBody, type AgentConversation, type AgentRow } from '../src/protocol/schema.ts';
import { shellApi } from '../src/shell/runtime.ts';
import './support/shell.css';

type Act = { readonly callable: string; readonly input: { readonly [key: string]: unknown } };
type Host = { status: AgentConversation['status']; rows: AgentRow[]; acts: Act[] };
const ID = 'composer';
const conversation = (status: AgentConversation['status']): AgentConversation => ({
	id: ID,
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
			if (act.callable === 'sys_message.post') {
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
			return Response.json({ answers: [{ rows: [conversation(host.status)] }] });
		return Response.json({
			answers: [{ rows: host.rows, status: host.status, inputs: [], outputs: [] }]
		});
	};
};
const withPanel = async (
	start: Partial<Host>,
	check: (host: Host) => Promise<void>,
	request: { readonly prompt?: string; readonly send?: string } = {}
) => {
	const host: Host = { status: 'idle', rows: [], acts: [], ...start };
	await page.viewport(1100, 800);
	sessionStorage.clear();
	const target = document.createElement('div');
	target.style.cssText = 'height:100dvh';
	document.body.replaceChildren(target);
	const runtime = ManagedRuntime.make(Layer.empty);
	const dispose = mountEdge(runtime);
	try {
		await runtime.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const fetch = fake(host);
					const bolt = yield* createBolt({
						actor: null,
						locale: 'en',
						base: location.origin,
						fetch,
						poll: '50 millis'
					});
					yield* Effect.promise(async () => {
						const view = mount(Agent, {
							target,
							props: {
								api: shellApi(fetch, { base: location.origin }),
								bolt,
								t: (key: string) => key,
								request: { conversation: ID, ...request },
								onClose: () => {}
							}
						});
						try {
							await expect
								.element(page.getByRole('textbox', { name: 'Message', exact: true }))
								.toBeVisible();
							await check(host);
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
	await withPanel({ status: 'running' }, async (host) => {
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
		await expect.poll(() => list('queue')).toBeNull();
		await expect.element(page.getByText('steer this')).toBeVisible();
	});
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
			await expect.poll(() => host.acts.at(-1)?.callable).toBe('sys_conversation.respondNow');
		}
	);
});
