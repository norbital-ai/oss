import { expect, it } from '@effect/vitest';
import { Deferred, Effect, Layer, ManagedRuntime } from 'effect';
import { mountEdge } from '@norbital-ai/ui/effect';
import { page } from 'vitest/browser';
import { mount, unmount } from 'svelte';
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

it.each(['ready', 'failed'] as const)(
	'sign-in enables its form and recovers from a send failure while methods are %s',
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
			const input = target.querySelector('#bolt-email');
			const action = target.querySelector('button[type="submit"]');
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
			expect(target.querySelector('#bolt-email')).toBe(input);
			await page.getByLabelText('Email address').fill('ada@x.test');
			await page.getByRole('button', { name: 'Send sign-in code' }).click();
			await expect.element(page.getByLabelText('Email address')).toBeDisabled();
			expect(target.querySelector('button[type="submit"]')).toBe(action);
			await Effect.runPromise(
				Deferred.fail(
					send,
					new ShellError({ code: 'Unavailable', message: 'Try again.', status: 503 })
				)
			);
			await expect.element(page.getByRole('alert')).toHaveTextContent('Try again.');
			await expect.element(page.getByLabelText('Email address')).toBeEnabled();
			expect(target.querySelector('#bolt-email')).toBe(input);
		} finally {
			await unmount(view);
			await dispose();
			target.remove();
		}
	}
);

it('invitation loading disables admission and presents a read failure', async () => {
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
		await Effect.runPromise(
			Deferred.fail(
				invitation,
				new ShellError({ code: 'Unavailable', message: 'Try again.', status: 503 })
			)
		);
		await expect.element(page.getByText('Try again.')).toBeInTheDocument();
	} finally {
		await unmount(view);
		await dispose();
		target.remove();
	}
});
