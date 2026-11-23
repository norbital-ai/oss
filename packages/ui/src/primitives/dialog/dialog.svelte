<script lang="ts" module>
	let nextDialogId = 0;
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { register_control } from '../../behaviors/index.js';
	import { set_dialog_context } from './context.js';

	let {
		open = $bindable(false),
		alert = false,
		on_open_change,
		on_open_change_complete,
		children
	}: {
		/** Whether the dialog is open; bindable. */
		open?: boolean;
		/** Render as an `alertdialog` (confirmation modal). */
		alert?: boolean;
		/** Called when open state changes. */
		on_open_change?: (open: boolean) => void;
		/** Called after open state finishes settling. */
		on_open_change_complete?: (open: boolean) => void;
		/** Trigger and content of the dialog. */
		children?: Snippet;
	} = $props();

	const id = `nb-dialog-${++nextDialogId}`;
	let hasTitle = $state(false);
	let hasDescription = $state(false);

	function set_open(next: boolean): void {
		if (next === open) return;
		open = next;
		on_open_change?.(next);
		queueMicrotask(() => on_open_change_complete?.(next));
	}

	set_dialog_context({
		get open() {
			return open;
		},
		set_open,
		get role() {
			return alert ? 'alertdialog' : 'dialog';
		},
		title_id: `${id}-title`,
		description_id: `${id}-desc`,
		get has_title() {
			return hasTitle;
		},
		get has_description() {
			return hasDescription;
		},
		mark_title: (present) => {
			hasTitle = present;
		},
		mark_description: (present) => {
			hasDescription = present;
		}
	});

	$effect(() => {
		if (!open) return;
		return register_control({
			id: `dialog:${id}`,
			kind: alert ? 'alertdialog' : 'dialog',
			state: () => ({ open }),
			actions: { close: () => set_open(false) }
		});
	});
</script>

{@render children?.()}
