<!-- @component One integration instance's setup and health over its client: the provider choice, pairing (a form, a QR or code, an OAuth sign-in), the connected summary, a test, reconnecting and disconnecting. Unboxed: the page that embeds it owns the surface. -->
<script lang="ts">
	import { Effect, Stream } from 'effect';
	import { live } from '@norbital-ai/ui/effect';
	import { watch } from 'runed';
	import { ProtocolFailed } from '../decl/errors.ts';
	import type { Json } from '../decl/values.ts';
	import type { InstanceStatus } from '../protocol/instance-status.ts';
	import Setup from '../shell/integration/Setup.svelte';
	import type { IntegrationSetupEntry } from '../shell/integration/setup.ts';
	import type { IntegrationClient } from './integrations.ts';

	let {
		client,
		setup,
		t = (key: string) => key,
		locale = 'en'
	}: {
		client: Pick<IntegrationClient, 'instance' | 'status' | 'pair' | 'unpair' | 'test' | 'watch'>;
		/** The definition's own `+integration.svelte`, drawn in place of the generic views. */
		setup?: IntegrationSetupEntry | undefined;
		t?: (key: string) => string;
		locale?: string;
	} = $props();
	const failure = (e: unknown) =>
		e instanceof Error ? e.message : t('The integration request failed. Try again.');

	const feed = live(() =>
		Stream.merge(
			Stream.fromEffect(
				client.status().pipe(
					Effect.mapError(
						() =>
							new ProtocolFailed({
								message: t('This integration could not be loaded. Check access and try again.')
							})
					)
				)
			),
			client.watch()
		)
	);
	let mutation = $state.raw<{
		owner: typeof client;
		token: symbol;
		busy: boolean;
		error: string | null;
	} | null>(null);
	let response = $state.raw<{
		owner: typeof client;
		observed: typeof feed.result;
		status: InstanceStatus;
	} | null>(null);
	const status = $derived(
		response?.owner === client && response.observed === feed.result
			? response.status
			: (feed.current ?? null)
	);
	const error = $derived(
		(mutation?.owner === client ? mutation.error : null) ??
			(feed.error === undefined ? null : failure(feed.error))
	);
	const busy = $derived(mutation?.owner === client && mutation.busy);
	// Only mutation state is local; reads and their failures belong to the query resource.
	watch(
		() => client,
		() => {
			mutation = null;
			response = null;
		}
	);
	const verb = (
		owner: typeof client,
		operation: Effect.Effect<InstanceStatus, unknown>
	): Effect.Effect<void> => {
		const token = Symbol();
		return Effect.gen(function* () {
			if (client !== owner) return;
			mutation = { owner, token, busy: true, error: null };
			const result = yield* Effect.result(operation);
			if (client !== owner || mutation?.token !== token) return;
			if (result._tag === 'Success')
				response = { owner, observed: feed.result, status: result.success };
			else mutation = { owner, token, busy: true, error: failure(result.failure) };
		}).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					if (client === owner && mutation?.token === token)
						mutation = { ...mutation, busy: false };
				})
			)
		);
	};
	const pair = (input?: Json) => {
		const owner = client;
		return verb(owner, owner.pair(input ?? {}));
	};
	const unpair = () => {
		const owner = client;
		return verb(owner, owner.unpair());
	};
	const test = (to?: string) => {
		const owner = client;
		return verb(owner, owner.test(to === undefined ? {} : { to }));
	};
</script>

<Setup
	instance={client.instance}
	{status}
	{error}
	{busy}
	{pair}
	{unpair}
	{test}
	{t}
	{locale}
	{setup}
/>
