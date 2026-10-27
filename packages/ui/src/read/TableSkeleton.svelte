<!--
	The shape of a short table page while its rows are read: a header band and six skeleton rows. It keeps the ready
	table's footprint, so the page does not jump when the answer arrives.
-->
<div class="bg-card divide-y overflow-hidden rounded-md border">
	<div class="bg-muted h-9"></div>
	{#each [62, 80, 48, 71, 55, 66] as w, i (i)}
		<div class="flex items-center gap-4 px-3 py-2.5">
			<div
				class="bg-muted h-3.5 animate-pulse rounded motion-reduce:animate-none"
				style="width:{w * 0.4}%"
			></div>
			<div
				class="bg-muted h-3 flex-1 animate-pulse rounded motion-reduce:animate-none"
				style="max-width:{w * 0.5}%"
			></div>
		</div>
	{/each}
</div>
