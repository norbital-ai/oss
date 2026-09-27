<!--
@component
A group of fields and inputs that share one mode: `readonly` or `disabled` set here reaches every control beneath through
context (a `Field` may still override it). Unset inherits the enclosing `Form` or `Fieldset`.
-->
<script lang="ts" module>
	import type { Snippet } from 'svelte';

	/** The props of `Fieldset`: the mode its controls share, an optional legend, and its content. */
	export type FieldsetProps = {
		/** Every control beneath shows its value as copyable text, no field chrome. */
		readonly?: boolean;
		/** Every control beneath stays, muted and inert (the native `<fieldset disabled>`). */
		disabled?: boolean;
		legend?: string;
		class?: string;
		children: Snippet;
	};
</script>

<script lang="ts">
	import { cn, provideControls } from '../primitives/utils.js';

	let { readonly, disabled, legend, class: className, children }: FieldsetProps = $props();
	const controls = provideControls(() => ({ readonly, disabled }));
</script>

<!-- readonly wins: a readonly group has no inputs left to disable, only copy buttons -->
<fieldset class={cn('m-0 grid min-w-0 gap-4 border-0 p-0', className)} disabled={controls.disabled && !controls.readonly}>
	{#if legend}<legend class="mb-2 p-0 text-sm font-medium">{legend}</legend>{/if}
	{@render children()}
</fieldset>
