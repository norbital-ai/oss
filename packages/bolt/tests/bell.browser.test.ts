import { expect, it } from '@effect/vitest';
import { Effect, Layer, ManagedRuntime, Queue, Stream } from 'effect';
import { mount_edge } from '@norbital-ai/ui/effect';
import { page, userEvent } from 'vitest/browser';
import { mount, unmount } from 'svelte';
import Bell from '../src/shell/Bell.svelte';
import type { NoticeRow } from '../src/protocol/schema.ts';
import type { ActOutcome } from '../src/engine/contracts.ts';
import './support/shell.css';

const at = new Date(Date.now() - 2 * 3_600_000).toISOString();
const notice = (id: string, title: string, fields: Partial<NoticeRow> = {}): NoticeRow => ({
	id,
	title,
	body: null,
	link: null,
	at,
	read: false,
	...fields
});
const order = { model: 'orders', id: '1' };

const opened = async (
	rows: readonly NoticeRow[],
	run: (seen: { read: string[][]; to: string[] }) => Promise<void>
) => {
	const dispose = mount_edge(ManagedRuntime.make(Layer.empty));
	const target = document.createElement('div');
	document.body.replaceChildren(target);
	const seen: { read: string[][]; to: string[] } = { read: [], to: [] };
	let current = [...rows];
	let emit: (() => void) | undefined;
	const answer = () => ({ rows: [...current], unread: current.filter((row) => !row.read).length });
	const done = Effect.succeed<ActOutcome>({ kind: 'committed', output: null, records: [] });
	const read = (ids: readonly string[]) => Effect.suspend(() => {
		seen.read.push([...ids]);
		current = current.map((row) => ids.includes(row.id) ? { ...row, read: true } : row);
		emit?.();
		return done;
	});
	const view = mount(Bell, {
		target,
		props: {
			api: {
				mark_notices_read: read,
				mark_all_notices_read: () => read(current.filter((row) => !row.read).map((row) => row.id))
			},
			bolt: {
				observe: () => Stream.callback<{ rows: NoticeRow[]; unread: number }>((queue) =>
					Effect.sync(() => {
						emit = () => { Queue.offerUnsafe(queue, answer()); };
						emit();
					})
				)
			},
			t: (key: string) => key,
			on_navigate: (href: string) => {
				seen.to.push(href);
			}
		}
	});
	try {
		await page.getByTestId('notification-bell').click();
		await run(seen);
	} finally {
		await unmount(view);
		await dispose();
		target.remove();
	}
};

it('puts what is addressed to the reader first and folds the workspace’s news away', () =>
	opened(
		[
			notice('event:merged:u1', 'Ada merged change !4'),
			notice('n2', 'Order approved', { link: order, body: 'Ready to ship' }),
			notice('n1', 'Order waiting on you', { link: order, read: true }),
			notice('n0', 'Payslip ready', { read: true })
		],
		async () => {
			await expect.element(page.getByText('Order approved')).toBeInTheDocument();
			await expect.element(page.getByText('Order waiting on you')).not.toBeInTheDocument();
			await expect.element(page.getByText('Ada merged change !4')).not.toBeInTheDocument();
			await page.getByRole('button', { name: /Workspace updates/ }).click();
			await expect.element(page.getByText('Ada merged change !4')).toBeInTheDocument();
		}
	));

it('shows the workspace’s news at once when there is nothing else', () =>
	opened([notice('event:merged:u1', 'Ada merged change !4')], async () => {
		await expect.element(page.getByText('Ada merged change !4')).toBeInTheDocument();
		await expect
			.element(page.getByRole('button', { name: /Workspace updates/ }))
			.not.toBeInTheDocument();
	}));

it('runs from the keyboard: moves, marks read, and opens a whole line', () =>
	opened(
		[
			notice('n3', 'Order approved', { link: order }),
			notice('n2', 'Order waiting on you', { link: order }),
			notice('n1', 'Payslip ready')
		],
		async (seen) => {
			const first = page.getByRole('button', { name: /Order approved/ });
			await expect.element(first).toHaveFocus();
			await userEvent.keyboard('j');
			await expect.element(page.getByRole('button', { name: /Payslip ready/ })).toHaveFocus();
			await userEvent.keyboard('u');
			expect(seen.read).toEqual([['n1']]);
			await userEvent.keyboard('k');
			await expect.element(first).toHaveFocus();
			await userEvent.keyboard('{Enter}');
			expect(seen.read.at(-1)).toEqual(['n3', 'n2']);
			expect(seen.to).toEqual(['/inbox?record=orders/1']);
		}
	));


it('keeps read lines steady until the next open, then folds them below an empty inbox', () =>
	opened([notice('n1', 'A completed update'), notice('n2', 'Another completed update')], async (seen) => {
		await expect.element(page.getByText('A completed update')).toBeVisible();
		// measure the settled popover, not its open animation
		await Promise.all(document.getAnimations().map((animation) => animation.finished));
		const before = page.getByRole('button', { name: /A completed update/ }).element().getBoundingClientRect();
		await page.getByRole('button', { name: 'Mark all read', exact: true }).click();
		await expect.poll(() => seen.read).toEqual([['n1', 'n2']]);
		await expect.element(page.getByText('A completed update')).toBeVisible();
		const after = page.getByRole('button', { name: /A completed update/ }).element().getBoundingClientRect();
		expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(1);
		await page.getByTestId('notification-bell').click();
		await page.getByTestId('notification-bell').click();
		await expect.element(page.getByText('You’re all caught up', { exact: true })).toBeVisible();
		await expect.element(page.getByText('A completed update')).not.toBeInTheDocument();
		const empty = document.querySelector<HTMLElement>('[data-notice-empty]');
		if (empty === null) throw new Error('Missing empty inbox');
		expect(empty.getBoundingClientRect().height).toBeGreaterThanOrEqual(140);
		const history = page.getByText('Read', { exact: true });
		await history.click();
		await expect.element(page.getByText('A completed update')).toBeVisible();
		await expect.element(page.getByText('Another completed update')).toBeVisible();
		await page.getByTestId('notification-bell').click();
		await page.getByTestId('notification-bell').click();
		await expect.element(page.getByText('A completed update')).not.toBeInTheDocument();
		await expect.element(page.getByText('You’re all caught up', { exact: true })).toBeVisible();
	})
);
