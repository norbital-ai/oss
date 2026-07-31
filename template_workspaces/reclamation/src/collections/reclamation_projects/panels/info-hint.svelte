<script lang="ts">
	import { IconWrapper } from '@norbital-ai/ui/icon-wrapper';
	import { Tooltip } from '@norbital-ai/ui/tooltip';

	/**
	 * The explanation, out of the way until it is wanted.
	 *
	 * A control panel that explains itself in paragraphs is read once and skimmed
	 * forever after, and the prose crowds out the controls that are the reason to
	 * be here. The words still matter — several of them are the difference between
	 * a drawn level and an assumed one — so they move behind the icon rather than
	 * being deleted.
	 */
	let { text, label = 'What this means' }: { text: string; label?: string } = $props();
</script>

<Tooltip {text} side="right" contentClass="max-w-[17rem] text-xs leading-snug">
	{#snippet trigger({ props })}
		<button
			type="button"
			class="shrink-0 rounded-full text-muted-foreground/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
			aria-label={label}
			{...props}
		>
			<IconWrapper name="lucide:info" class="size-3.5" />
		</button>
	{/snippet}
</Tooltip>
