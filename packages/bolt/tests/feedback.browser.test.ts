import { expect, it } from '@effect/vitest';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { mount_edge } from '@norbital-ai/ui/effect';
import { page } from 'vitest/browser';
import { mount, unmount } from 'svelte';
import Feedback from '../src/shell/Feedback.svelte';

it('the Feedback dialog says how it works, sends the words with the page they were on, and closes', async () => {
	const dispose = mount_edge(ManagedRuntime.make(Layer.empty));
	document.body.replaceChildren();
	const target = document.createElement('div');
	document.body.append(target);
	const sent: { text: string; files: number; route: string }[] = [];
	let closed = 0;
	const view = mount(Feedback, {
		target,
		props: {
			api: {
				agent: { upload: () => Effect.succeed({ id: 'file-1' }) },
				feedback: (text: string, files: readonly { readonly id: string }[], route: string) =>
					Effect.sync(() => void sent.push({ text, files: files.length, route }))
			},
			t: (key: string) => key,
			route: '/app/sales/quotes',
			on_close: () => closed++
		}
	});
	try {
		await expect
			.element(
				page.getByText(
					/What you send goes to your workspace's administrators\.\s*They read it, and an assistant may help prepare a fix\./
				)
			)
			.toBeInTheDocument();
		const send = page.getByRole('button', { name: 'Send', exact: true });
		// nothing to send yet
		await expect.element(send).toBeDisabled();
		await page.getByRole('textbox', { name: 'Feedback' }).fill('The total is wrong');
		await send.click();
		await expect.poll(() => closed).toBe(1);
		expect(sent).toEqual([{ text: 'The total is wrong', files: 0, route: '/app/sales/quotes' }]);
	} finally {
		await unmount(view);
		await dispose();
		target.remove();
	}
});

it('the Feedback dialog leaves nothing behind when its owner unmounts it open', async () => {
	const dispose = mount_edge(ManagedRuntime.make(Layer.empty));
	document.body.replaceChildren();
	const target = document.createElement('div');
	document.body.append(target);
	const view = mount(Feedback, {
		target,
		props: {
			api: { agent: { upload: () => Effect.succeed({ id: 'file-1' }) }, feedback: () => Effect.void },
			t: (key: string) => key,
			route: '/',
			on_close: () => {}
		}
	});
	await expect.element(page.getByRole('dialog')).toBeInTheDocument();
	await unmount(view);
	await dispose();
	expect(document.querySelector('[role="dialog"]')).toBeNull();
	target.remove();
});
