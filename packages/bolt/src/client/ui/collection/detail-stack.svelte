<script lang="ts">
	import type { DetailLocation } from '../state/platform.js';
	let {
		stack = [],
		onselect,
		onclose
	}: {
		stack?: ReadonlyArray<DetailLocation>;
		onselect?: (index: number) => void;
		onclose?: () => void;
	} = $props();
</script>

<nav aria-label="Record detail history">
	<header>
		<h2>Open records</h2>
		{#if stack.length > 0 && onclose}
			<button type="button" onclick={onclose}>Close all</button>
		{/if}
	</header>
	{#if stack.length === 0}
		<p>No record is open.</p>
	{:else}
		<ol aria-label="Detail stack">
			{#each stack as item, index (`${item.collection}:${item.recordId}:${index}`)}
				<li>
					<button
						type="button"
						aria-current={index === stack.length - 1 ? 'page' : undefined}
						onclick={() => onselect?.(index)}
					>
						<span>{item.collection}</span>
						<code>{item.recordId}</code>
					</button>
				</li>
			{/each}
		</ol>
	{/if}
</nav>

<style>
	header,
	button {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}
	h2,
	p,
	ol {
		margin: 0;
	}
	ol {
		display: grid;
		gap: 0.25rem;
		padding: 0;
		list-style: none;
	}
	li button {
		width: 100%;
		padding: 0.5rem;
		text-align: start;
	}
	button[aria-current='page'] {
		font-weight: 700;
	}
	code {
		opacity: 0.7;
	}
</style>
