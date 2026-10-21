<!--
	The in-app confirmation `confirmAction` mounts: the Dialog primitive's content under an alert-dialog root (role
	`alertdialog`, focus trapped from Cancel, Escape and the close button cancel). It answers once — confirm, or cancel
	by any dismissal — and asks to be removed once its close settles.
-->
<script lang="ts">
	import { AlertDialog } from 'bits-ui';
	import { Button } from '../button/index.js';
	import { uiText } from '../utils.js';
	import Content from './dialog-content.svelte';
	import Description from './dialog-description.svelte';
	import Footer from './dialog-footer.svelte';
	import Header from './dialog-header.svelte';
	import Title from './dialog-title.svelte';
	import type { ConfirmOptions } from './confirm.js';

	let {
		title,
		body,
		confirmLabel,
		cancelLabel,
		destructive = false,
		onAnswer,
		onClosed
	}: ConfirmOptions & { onAnswer: (confirmed: boolean) => void; onClosed: () => void } = $props();
	const t = uiText();
	let open = $state(true);
	let answered = false;
	const answer = (confirmed: boolean) => {
		if (answered) return;
		answered = true;
		open = false;
		onAnswer(confirmed);
		// the close animation's completion is not guaranteed (a throttled tab, no animation): remove after it at the latest,
		// or the dismissed layer keeps the page under its overlay and focus lock
		setTimeout(onClosed, 300);
	};
</script>

<AlertDialog.Root
	bind:open
	onOpenChange={(next) => {
		if (!next) answer(false);
	}}
	onOpenChangeComplete={(next) => {
		if (!next) onClosed();
	}}
>
	<!-- the alert-dialog root makes the same content an `alertdialog` -->
	<!-- no focus restore on close: over an open sheet the two traps would hand focus back and forth -->
	<Content
		class="max-w-md"
		data-confirm-dialog
		onCloseAutoFocus={(event: Event) => event.preventDefault()}
	>
		<Header>
			<Title>{title}</Title>
			{#if body !== undefined}<Description>{body}</Description>{/if}
		</Header>
		<Footer>
			<Button variant="outline" onclick={() => answer(false)} data-confirm-cancel
				>{cancelLabel ?? t('cancel')}</Button
			>
			<Button
				variant={destructive ? 'destructive' : 'default'}
				onclick={() => answer(true)}
				data-confirm-accept>{confirmLabel}</Button
			>
		</Footer>
	</Content>
</AlertDialog.Root>
