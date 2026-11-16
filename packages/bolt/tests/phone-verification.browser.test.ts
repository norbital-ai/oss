import { expect, it } from '@effect/vitest';
import { Deferred, Effect, Layer, ManagedRuntime } from 'effect';
import { mount_edge } from '@norbital-ai/ui/effect';
import { page } from 'vitest/browser';
import { mount, tick, unmount } from 'svelte';
import Harness from './support/phone-verification.svelte';
import { required } from './support/required.ts';
import './support/shell.css';

it('phone auto-verify blocks manual verify, resend and number changes, then closes the spent code', async () => {
	const dispose = mount_edge(ManagedRuntime.make(Layer.empty));
	const pending = Deferred.makeUnsafe<void, { readonly message: string }>();
	let verifies = 0,
		sends = 0;
	const target = document.createElement('div');
	document.body.replaceChildren(target);
	const view = mount(Harness, {
		target,
		props: {
			session: {
				send_code: () =>
					Effect.sync(() => {
						sends++;
					}),
				verify: () => {
					verifies++;
					return Deferred.await(pending);
				}
			}
		}
	});
	try {
		await page.getByLabelText('Mobile number').fill('91234567');
		await page.getByRole('button', { name: 'Send code', exact: true }).click();
		await expect
			.poll(() => document.querySelector('input[autocomplete="one-time-code"]'))
			.toBeTruthy();
		const input = required(
			document.querySelector<HTMLInputElement>('input[autocomplete="one-time-code"]')
		);
		const verify = required(
			Array.from(document.querySelectorAll('button')).find(
				(button) => button.textContent?.trim() === 'Verify'
			)
		);
		input.value = '123456';
		input.dispatchEvent(
			new InputEvent('input', { bubbles: true, data: '123456', inputType: 'insertText' })
		);
		verify.click();
		verify.click();
		await expect.poll(() => verifies).toBe(1);
		await expect.element(page.getByRole('button', { name: 'Resend code' })).toBeDisabled();
		await expect.element(page.getByRole('button', { name: 'Change number' })).toBeDisabled();
		expect(sends).toBe(1);
		await Effect.runPromise(Deferred.succeed(pending, undefined));
		await expect
			.poll(() => document.querySelector('input[autocomplete="one-time-code"]'))
			.toBeNull();
		verify.click();
		await tick();
		expect(verifies).toBe(1);
	} finally {
		await unmount(view);
		await dispose();
		target.remove();
	}
});
