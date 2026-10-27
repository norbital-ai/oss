<!--
@component
A field's description as an info button beside its label: a tap or click opens the text, never a paragraph under the control.
-->
<script lang="ts">
	import * as Popover from '../primitives/popover/index.js';
	import Glyph from '../primitives/icon/Glyph.svelte';
	import { cn } from '../primitives/utils.js';

	let { text, class: className }: { text: string; class?: string } = $props();
</script>

<Popover.Root>
	<Popover.Trigger
		type="button"
		class={cn(
			'text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring/40 grid size-5 shrink-0 place-items-center rounded-sm outline-none focus-visible:ring-2 max-sm:size-8',
			className
		)}
		aria-label={text}
		title={text}
		data-field-description
	>
		<Glyph name="info" class="size-3.5" />
	</Popover.Trigger>
	<Popover.Content
		side="top"
		align="start"
		class="max-w-80 p-2 text-xs leading-relaxed whitespace-normal"
	>
		{text}
	</Popover.Content>
</Popover.Root>
