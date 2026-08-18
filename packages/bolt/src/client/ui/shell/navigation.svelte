<script lang="ts">
	/**
	 * Legacy application navigation list. Workspace chrome now lives in `shell.svelte`
	 * via `@norbital-ai/ui/workspace-shell`. This export remains for backward compatibility.
	 */
	let {
		apps = [],
		current = '',
		collapsed = false,
		loading = false
	}: {
		apps?: ReadonlyArray<string>;
		current?: string;
		collapsed?: boolean;
		loading?: boolean;
	} = $props();
	let expanded = $state(true);
</script>

<nav aria-label="Applications" aria-busy={loading} data-superseded="workspace-shell">
	<header>
		<strong>Applications</strong>
		{#if collapsed}
			<button type="button" aria-expanded={expanded} onclick={() => (expanded = !expanded)}>
				{expanded ? 'Hide' : 'Show'}
			</button>
		{/if}
	</header>
	{#if expanded}
		<ul>
			{#each apps as app (app)}
				<li>
					<a
						aria-current={app === current ? 'page' : undefined}
						href={`/app/${app}`}
						class="rounded-md px-2 py-1.5 text-xs text-foreground hover:bg-accent hover:text-accent-foreground"
					>
						{app}
					</a>
				</li>
			{:else}
				<li class="px-2 py-1.5 text-xs text-muted-foreground">No applications are visible.</li>
			{/each}
		</ul>
	{/if}
</nav>

<style>
	nav {
		display: grid;
		gap: 0.75rem;
	}
	header {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
	ul {
		display: grid;
		gap: 0.25rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	a[aria-current='page'] {
		background: var(--accent);
		color: var(--accent-foreground);
		font-weight: 600;
	}
</style>
