<!--
	The in-app confirmation `confirm_action` mounts: the Dialog primitive's content under an alert-dialog root (role
	`alertdialog`, focus trapped from Cancel, Escape and the close button cancel). It answers once — confirm, or cancel
	by any dismissal — and asks to be removed once its close settles.
-->
<script lang="ts">
	import { Button } from '../button/index.js';
	import { ui_text } from '../utils.js';
	import Root from './dialog.svelte';
	import Content from './dialog-content.svelte';
	import Description from './dialog-description.svelte';
	import Footer from './dialog-footer.svelte';
	import Header from './dialog-header.svelte';
	import Title from './dialog-title.svelte';
	import type { ConfirmOptions } from './confirm.js';

	let {
		title,
		body,
		confirm_label,
		cancel_label,
		destructive = false,
		on_answer,
		on_closed
	}: ConfirmOptions & { on_answer: (confirmed: boolean) => void; on_closed: () => void } = $props();
	const t = ui_text();
	let open = $state(true);
	let answered = false;
	const answer = (confirmed: boolean) => {
		if (answered) return;
		answered = true;
		open = false;
		on_answer(confirmed);
		setTimeout(on_closed, 300);
	};
</script>

<Root
	alert
	bind:open
	on_open_change={(next) => {
		if (!next) answer(false);
	}}
	on_open_change_complete={(next) => {
		if (!next) on_closed();
	}}
>
	<!-- no focus restore on close: over an open sheet the two traps would hand focus back and forth -->
	<!-- a confirmation is a centred decision, never a page-edge sheet -->
	<Content
		class="max-w-md rounded-overlay"
		data-confirm-dialog
		data-mobile-bottom-sheet="false"
		on_close_auto_focus={(event: Event) => event.preventDefault()}
	>
		<Header>
			<Title>{title}</Title>
			{#if body !== undefined}<Description>{body}</Description>{/if}
		</Header>
		<Footer>
			<Button variant="outline" onclick={() => answer(false)} data-confirm-cancel
				>{cancel_label ?? t('cancel')}</Button
			>
			<Button
				variant={destructive ? 'destructive' : 'default'}
				onclick={() => answer(true)}
				data-confirm-accept>{confirm_label}</Button
			>
		</Footer>
	</Content>
</Root>
