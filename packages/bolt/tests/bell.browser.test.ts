import { expect, it } from '@effect/vitest';
import { Effect, Layer, ManagedRuntime, Stream } from 'effect';
import { mountEdge } from '@norbital-ai/ui/effect';
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
	const dispose = mountEdge(ManagedRuntime.make(Layer.empty));
	const target = document.createElement('div');
	document.body.replaceChildren(target);
	const seen: { read: string[][]; to: string[] } = { read: [], to: [] };
	const done = Effect.succeed<ActOutcome>({ kind: 'running', run: 'r' });
	const view = mount(Bell, {
		target,
		props: {
			api: {
				markNoticesRead: (ids: readonly string[]) =>
					Effect.suspend(() => {
						seen.read.push([...ids]);
						return done;
					}),
				markAllNoticesRead: () => done
			},
			bolt: {
				observe: () =>
					Stream.concat(
						Stream.make({ rows: [...rows], unread: rows.filter((row) => !row.read).length }),
						Stream.never
					)
			},
			t: (key: string) => key,
			onNavigate: (href: string) => {
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
			await expect.element(page.getByText('2 updates', { exact: false })).toBeInTheDocument();
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
