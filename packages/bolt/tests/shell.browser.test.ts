import { expect, it } from '@effect/vitest';
import { Layer, ManagedRuntime } from 'effect';
import { mountEdge } from '@norbital-ai/ui/effect';
import { page } from 'vitest/browser';
import { mount, unmount } from 'svelte';
import SignIn from '../src/shell/auth/SignIn.svelte';
import { shellApi } from '../src/shell/runtime.ts';

const api = shellApi(async (url) =>
	Response.json({
		value: String(url).endsWith('/methods')
			? { email: true, phone: false, whatsapp: false, signup: [], locale: 'en' }
			: String(url).endsWith('/verify')
				? { user: 'u1' }
				: null
	})
);

it('Sign-in card locators fill an email and send the code in Chromium (L-BOLT-1011)', async () => {
	const dispose = mountEdge(ManagedRuntime.make(Layer.empty));
	document.body.replaceChildren();
	const target = document.createElement('div');
	document.body.append(target);
	const view = mount(SignIn, {
		target,
		props: {
			api,
			t: (key: string) => key,
			next: '/',
			workspace: 'Acme'
		}
	});
	try {
		await expect.element(page.getByLabelText('Email address')).toBeInTheDocument();
		await expect.element(page.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
		await expect.element(page.getByText('Acme')).toBeInTheDocument();
		await page.getByLabelText('Email address').fill('ada@x.test');
		await page.getByRole('button', { name: 'Send sign-in code' }).click();
		await expect
			.element(page.getByRole('heading', { name: 'Enter your code' }))
			.toBeInTheDocument();
		await expect.element(page.getByText('Sent to ada@x.test')).toBeInTheDocument();
	} finally {
		await unmount(view);
		await dispose();
		target.remove();
	}
});
