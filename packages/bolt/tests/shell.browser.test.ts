import { expect, it } from '@effect/vitest';
import { Deferred, Effect, Layer, ManagedRuntime } from 'effect';
import { mountEdge } from '@norbital-ai/ui/effect';
import { page } from 'vitest/browser';
import { mount, unmount } from 'svelte';
import SignIn from '../src/shell/auth/SignIn.svelte';
import { shellApi } from '../src/shell/runtime.ts';
import { ShellError, type Invitation } from '../src/shell/api-types.ts';
import type { SignInMethods } from '../src/shell/host.ts';
import AccessCard from './support/access-card.svelte';
import './support/shell.css';

const api = shellApi(async (url) =>
	Response.json({
		value: String(url).endsWith('/methods')
			? { email: true, phone: false, whatsapp: false, signup: [], locale: 'en' }
			: String(url).endsWith('/verify')
				? { user: 'u1' }
				: null
	})
);

const bounds = (target: HTMLElement, selector: string) => {
	const element = target.querySelector(selector);
	if (element === null) throw new Error(`Missing access fixture element: ${selector}`);
	const { x, y, width, height } = element.getBoundingClientRect();
	return { x, y, width, height };
};

const accessBounds = (target: HTMLElement) =>
	[
		'.access-panel',
		'.access-identity',
		'#bolt-email',
		'button[type="submit"]',
		'.access-sign-in-footer'
	].map((selector) => bounds(target, selector));

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

it.each(['ready', 'failed'] as const)(
	'sign-in retains its form, error slot and access card while methods are %s',
	async (result) => {
		const dispose = mountEdge(ManagedRuntime.make(Layer.empty));
		const methods = Deferred.makeUnsafe<SignInMethods, ShellError>();
		const send = Deferred.makeUnsafe<void, ShellError>();
		const target = document.createElement('div');
		document.body.replaceChildren(target);
		const view = mount(AccessCard, {
			target,
			props: {
				api: {
					...api,
					methods: () => Deferred.await(methods),
					sendCode: () => Deferred.await(send)
				}
			}
		});
		try {
			await expect.element(page.getByLabelText('Email address')).toBeDisabled();
			await expect.element(page.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
			const panel = target.querySelector('.access-panel');
			const input = target.querySelector('#bolt-email');
			const footer = target.querySelector('.access-sign-in-footer');
			const description = target.querySelector('.access-sign-in-description');
			const error = target.querySelector('.access-sign-in-error');
			const action = target.querySelector('button[type="submit"]');
			expect(panel).not.toBeNull();
			expect(description).toBeNull();
			expect(error).not.toBeNull();
			const pendingBounds = accessBounds(target);
			await Effect.runPromise(
				result === 'ready'
					? Deferred.succeed(methods, {
							email: true,
							phone: false,
							whatsapp: false,
							signup: [],
							locale: 'en'
						})
					: Deferred.fail(
							methods,
							new ShellError({ code: 'Unavailable', message: 'Unavailable', status: 503 })
						)
			);
			await expect.element(page.getByLabelText('Email address')).toBeEnabled();
			expect(accessBounds(target)).toEqual(pendingBounds);
			expect(target.querySelector('#bolt-email')).toBe(input);
			expect(target.querySelector('.access-panel')).toBe(panel);
			expect(target.querySelector('.access-sign-in-footer')).toBe(footer);
			await page.getByLabelText('Email address').fill('ada@x.test');
			await page.getByRole('button', { name: 'Send sign-in code' }).click();
			await expect.element(page.getByLabelText('Email address')).toBeDisabled();
			expect(accessBounds(target)).toEqual(pendingBounds);
			expect(target.querySelector('button[type="submit"]')).toBe(action);
			await Effect.runPromise(
				Deferred.fail(
					send,
					new ShellError({ code: 'Unavailable', message: 'Try again.', status: 503 })
				)
			);
			await expect.element(page.getByRole('alert')).toHaveTextContent('Try again.');
			await expect.element(page.getByLabelText('Email address')).toBeEnabled();
			expect(accessBounds(target)).toEqual(pendingBounds);
			expect(target.querySelector('#bolt-email')).toBe(input);
			expect(target.querySelector('.access-sign-in-description')).toBe(description);
			expect(target.querySelector('.access-sign-in-error')).toBe(error);
			expect(target.querySelector('.access-sign-in-footer')).toBe(footer);
			expect(target.querySelector('.access-panel')).toBe(panel);
		} finally {
			await unmount(view);
			await dispose();
			target.remove();
		}
	}
);

it('invitation loading and refusal keep the access card and workspace header mounted', async () => {
	const dispose = mountEdge(ManagedRuntime.make(Layer.empty));
	const invitation = Deferred.makeUnsafe<Invitation, ShellError>();
	const target = document.createElement('div');
	document.body.replaceChildren(target);
	const view = mount(AccessCard, {
		target,
		props: {
			api: { ...api, invitation: () => Deferred.await(invitation) },
			invitation: { id: 'invite', signedIn: true }
		}
	});
	try {
		await expect.element(page.getByText('Acme')).toBeInTheDocument();
		await expect
			.element(page.getByRole('button', { name: 'Accept the invitation' }))
			.toBeDisabled();
		const panel = target.querySelector('.access-panel');
		const header = target.querySelector('.access-invitation > header');
		await Effect.runPromise(
			Deferred.fail(
				invitation,
				new ShellError({ code: 'Unavailable', message: 'Try again.', status: 503 })
			)
		);
		await expect.element(page.getByText('Try again.')).toBeInTheDocument();
		expect(target.querySelector('.access-panel')).toBe(panel);
		expect(target.querySelector('.access-invitation > header')).toBe(header);
	} finally {
		await unmount(view);
		await dispose();
		target.remove();
	}
});
