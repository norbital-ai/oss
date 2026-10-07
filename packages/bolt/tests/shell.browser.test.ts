import { expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { mount, unmount } from 'svelte';
import SignIn from '../src/shell/SignIn.svelte';
import type { ShellApi } from '../src/shell/runtime.ts';

const api = {
	methods: async () => ({
		ok: true as const,
		value: { email: true, phone: false, whatsapp: false, signup: [] as string[], locale: 'en' }
	}),
	sendCode: async () => ({ ok: true as const, value: null }),
	verify: async () => ({ ok: true as const, value: null })
} as unknown as ShellApi;

test('Sign-in card locators fill an email and send the code in Chromium (L-BOLT-1011)', async () => {
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
		await expect.element(page.getByRole('heading', { name: 'Enter your code' })).toBeInTheDocument();
		await expect.element(page.getByText('Sent to ada@x.test')).toBeInTheDocument();
	} finally {
		unmount(view);
		target.remove();
	}
});
