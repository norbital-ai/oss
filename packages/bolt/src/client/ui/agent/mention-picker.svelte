<script lang="ts">
	let {
		options = [],
		query = '',
		onselect,
		onclose
	}: {
		options?: ReadonlyArray<string>;
		query?: string;
		onselect?: (value: string) => void;
		onclose?: () => void;
	} = $props();
	let active = $state(0);
	let filtered = $derived(options.filter((option) => option.toLowerCase().includes(query.toLowerCase())));
</script>

<section aria-label="Mention suggestions">
	{#if filtered.length === 0}
		<p>No matching people or records.</p>
	{:else}
		<ul aria-label="Mentions" role="listbox" tabindex="0" onkeydown={(event) => {
			if (event.key === 'ArrowDown') active = Math.min(active + 1, filtered.length - 1);
			if (event.key === 'ArrowUp') active = Math.max(active - 1, 0);
			if (event.key === 'Escape') onclose?.();
			if (event.key === 'Enter') {
				const value = filtered[active];
				if (value) {
					onselect?.(value);
					onclose?.();
				}
			}
		}}>
			{#each filtered as option, index (option)}
				<li>
					<button type="button" role="option" aria-selected={index === active} onclick={() => {
						onselect?.(option);
						onclose?.();
					}}>{option}</button>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	ul { display: grid; gap: .25rem; margin: 0; padding: .25rem; list-style: none; }
	button { width: 100%; padding: .5rem; text-align: start; }
	button[aria-selected='true'] { font-weight: 700; outline: 2px solid currentColor; }
	p { margin: 0; padding: .75rem; }
</style>
