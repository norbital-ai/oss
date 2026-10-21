<!--
	A connected instance's details: the facts the host published (the webhook URL, an address, a bot) — who it answers as
	and through which provider are the status line above, never repeated here — then its verbs. Test connection sends a
	short message where a conversation provider can (to a handle the operator types when the provider names one, else to
	the account itself) and runs the definition's own test; Reconnect draws the setup again; Disconnect (only where no
	card above owns it) asks in-app, then unpairs.
-->
<script lang="ts">
	import { Effect } from 'effect';
	import { fork } from '@norbital-ai/ui/effect';
	import { Button, confirmAction, Input } from '@norbital-ai/ui';
	import { Cluster, Stack } from '@norbital-ai/ui/layout';
	import type { Json } from '../../decl/values.ts';
	import type { ImportStartInput } from '../../protocol/instance-status.ts';
	import { DRIVERS } from '../../decl/runtime/integration.ts';
	import Facts from './Facts.svelte';
	import ImportStart from './ImportStart.svelte';
	import { importStartDraft, importStartLabel, validImportStart } from './import-start.ts';
	import { aboutOf, providerOf, sayOf, type IntegrationSetupProps } from './setup.ts';

	let {
		status,
		busy,
		error,
		unpair,
		test,
		importStart,
		reconnect,
		controls = true,
		t,
		locale
	}: Pick<
		IntegrationSetupProps,
		'status' | 'busy' | 'error' | 'unpair' | 'test' | 'importStart' | 't' | 'locale'
	> & {
		reconnect: () => void;
		controls?: boolean | undefined;
	} = $props();
	const say = $derived(sayOf(t, locale));
	const c = $derived(status);
	const active = $derived(providerOf(c));
	// `account` is the status line's "Connected as"; the same fact under `about` would be its second copy
	const facts = $derived<(readonly [string, Json])[]>(
		Object.entries(aboutOf(c)).filter(([k, v]) => k !== 'account' || v !== c?.account)
	);
	// a conversation provider tests only when it says it can; any other driver runs its definition's own test
	const testable = $derived(
		c !== null && (c.test !== undefined || !('conversation' in DRIVERS[c.driver]))
	);
	// a provider with nothing to pair (setup `none`) has nothing to reconnect or disconnect
	const paired = $derived(active?.setup.kind !== 'none');
	let boundary = $state<ImportStartInput | undefined>(undefined);
	let applied = $state(false);
	const draft = $derived(
		active === undefined ? undefined : (boundary ?? importStartDraft(c?.importStart, active))
	);
	function apply(event: SubmitEvent): void {
		event.preventDefault();
		if (draft === undefined || active === undefined || !validImportStart(draft, active)) return;
		applied = false;
		fork(
			importStart(draft).pipe(
				Effect.tap((success) =>
					Effect.sync(() => {
						applied = success;
					})
				)
			)
		);
	}
	let to = $state('');
	let tested = $state(false);
	function send(event: SubmitEvent): void {
		event.preventDefault();
		tested = false;
		fork(
			test(c?.test?.to === undefined ? undefined : to.trim()).pipe(
				Effect.tap(() =>
					Effect.sync(() => {
						tested = true;
					})
				)
			)
		);
	}
</script>

<Stack gap="md" data-setup-view="connected">
	<Facts {facts} {t} />
	{#if active?.importStart !== undefined && draft !== undefined}
		{#if controls}<p class="text-meta" data-import-start-active>
				{t('Import start')}: {importStartLabel(c?.importStart, t, locale)}
			</p>{/if}
		{#if controls && c?.importStart?.kind === 'since' && c.importStart.origin === 'now' && active.importStart.kind === 'timestamp' && active.importStart.precision === 'second'}
			<p class="text-meta" data-import-start-precision>
				{t('This source timestamps messages to the second; the whole starting second is included.')}
			</p>
		{/if}
		<form class="flex flex-col gap-3" onsubmit={apply} data-import-start-form>
			<ImportStart
				provider={active}
				value={draft}
				onChange={(value) => {
					boundary = value;
					applied = false;
				}}
				{busy}
				{t}
				{locale}
			/>
			<p class="text-meta">
				{t('Changes affect future imports. Previously imported messages stay in the workspace.')}
			</p>
			<Cluster gap="sm">
				<Button
					size="sm"
					variant="outline"
					type="submit"
					disabled={busy ||
						boundary === undefined ||
						(applied && error === null) ||
						!validImportStart(draft, active)}
					>{busy ? t('Applying…') : t('Apply import start')}</Button
				>
				{#if applied && !busy && error === null}<span class="text-meta" role="status"
						>{t('Import start updated')}</span
					>{/if}
			</Cluster>
		</form>
	{/if}
	<form class="flex flex-col gap-2" onsubmit={send} data-setup-test>
		{#if c?.test?.to !== undefined}
			<label class="flex flex-col gap-1 text-sm">
				<span class="text-label">{say(c.test.to.label)}</span>
				<Input bind:value={to} required />
				{#if c.test.to.hint !== undefined}<span class="text-meta">{say(c.test.to.hint)}</span>{/if}
			</label>
		{/if}
		<Cluster gap="sm">
			{#if testable}<Button size="sm" variant="outline" type="submit" disabled={busy}
					>{t('Test connection')}</Button
				>{/if}
			{#if paired}
				<Button size="sm" variant="ghost" disabled={busy} onclick={reconnect} data-reconnect
					>{t('Reconnect')}</Button
				>
			{/if}
			{#if paired && controls}
				<Button
					size="sm"
					variant="ghost"
					class="text-destructive"
					disabled={busy}
					data-disconnect
					onclick={() =>
						fork(
							confirmAction({
								title: t('Disconnect {name}?').replace(
									'{name}',
									active === undefined ? (c?.account ?? '') : say(active.label)
								),
								body: t('This logs the account out and deletes its stored credentials.'),
								confirmLabel: t('Disconnect'),
								cancelLabel: t('Cancel'),
								destructive: true
							}).pipe(Effect.flatMap((confirmed) => (confirmed ? unpair() : Effect.void)))
						)}>{t('Disconnect')}</Button
				>
			{/if}
			<!-- the holder shows a refused test as its error, so "passed" is only a test that drew none -->
			{#if tested && !busy && error === null}<span class="text-meta" aria-live="polite"
					>{t('Test passed')}</span
				>{/if}
		</Cluster>
	</form>
</Stack>
