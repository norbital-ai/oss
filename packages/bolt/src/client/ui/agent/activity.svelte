<script lang="ts">
	let {
		events = [],
		active = false,
		onclear
	}: {
		events?: ReadonlyArray<string>;
		active?: boolean;
		onclear?: () => void;
	} = $props();
</script>

<section aria-labelledby="agent-activity-title" aria-live="polite">
	<header>
		<div>
			<h2 id="agent-activity-title">Activity</h2>
			<p>{active ? 'The agent is working' : 'Latest agent actions'}</p>
		</div>
		{#if events.length > 0 && onclear}
			<button type="button" onclick={onclear}>Clear</button>
		{/if}
	</header>
	{#if active}
		<div class="progress" role="status">
			<span aria-hidden="true"></span>
			Working…
		</div>
	{/if}
	{#if events.length === 0}
		<p class="empty">No agent activity yet.</p>
	{:else}
		<ol aria-label="Agent activity">
			{#each events as event, index}
				<li><span>{index + 1}</span>{event}</li>
			{/each}
		</ol>
	{/if}
</section>

<style>
	header { display: flex; align-items: start; justify-content: space-between; gap: 1rem; }
	h2, header p { margin: 0; }
	ol { display: grid; gap: .5rem; padding: 0; list-style: none; }
	li { display: flex; gap: .75rem; }
	li span { font-variant-numeric: tabular-nums; opacity: .6; }
	.progress, .empty { padding-block: .75rem; }
</style>
