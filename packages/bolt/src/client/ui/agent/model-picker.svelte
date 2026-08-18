<script lang="ts">
	let {
		models = [],
		selected = '',
		disabled = false,
		onselect
	}: {
		models?: ReadonlyArray<string>;
		selected?: string;
		disabled?: boolean;
		onselect?: (model: string) => void;
	} = $props();
</script>

<section aria-labelledby="model-picker-title">
	<header>
		<h2 id="model-picker-title">Model</h2>
		{#if selected}<span aria-label="Selected model">{selected}</span>{/if}
	</header>
	{#if models.length === 0}
		<p role="status">No models are available for this agent.</p>
	{:else}
		<div role="listbox" aria-label="Model" aria-disabled={disabled}>
			{#each models as model (model)}
				<button
					type="button"
					role="option"
					aria-selected={model === selected}
					{disabled}
					onclick={() => {
						if (!disabled) onselect?.(model);
					}}
				>
					<span>{model}</span>
					{#if model === selected}<span aria-hidden="true">✓</span>{/if}
				</button>
			{/each}
		</div>
	{/if}
</section>

<style>
	header, button { display: flex; align-items: center; justify-content: space-between; gap: .75rem; }
	h2, p { margin: 0; }
	[role='listbox'] { display: grid; gap: .25rem; margin-block-start: .5rem; }
	button { width: 100%; padding: .5rem; }
	button[aria-selected='true'] { font-weight: 700; }
</style>
