<script lang="ts">
	type Summary = {
		ytd_pending: number;
		ytd_approved: number;
		average_approval_hours: number | null;
		approval_sample_size: number;
	};

	interface Props {
		title: string;
		asOfDate: string;
		summary: Summary;
		pendingLabel?: string;
		note: string;
	}

	let { title, asOfDate, summary, pendingLabel = 'Yet to approve', note }: Props = $props();
	const headingId = $props.id();

	function formatApprovalSpeed(hours: number | null): string {
		if (hours == null) return 'Not tracked';
		if (hours < 24) return `${hours.toFixed(hours < 10 ? 1 : 0)} hr`;
		const days = hours / 24;
		return `${days.toFixed(days < 10 ? 1 : 0)} days`;
	}
</script>

<section class="rounded-lg border bg-card shadow-card" aria-labelledby={headingId}>
	<div class="border-b px-4 py-3">
		<h3 id={headingId} class="text-sm font-semibold">{title}</h3>
		<p class="mt-0.5 text-xs text-muted-foreground">
			Year to date · through {new Date(`${asOfDate}T00:00:00.000Z`).toLocaleDateString()}
		</p>
	</div>
	<!-- stupidity:allow UI3 -- this is a derived three-row analytical summary, not collection data. -->
	<table class="w-full table-fixed text-sm">
		<thead class="sr-only">
			<tr><th>Metric</th><th>Year-to-date result</th></tr>
		</thead>
		<tbody class="divide-y">
			<tr>
				<th scope="row" class="w-2/3 px-4 py-2.5 text-left font-medium">{pendingLabel}</th>
				<td class="px-4 py-2.5 text-right font-semibold tabular-nums">
					{summary.ytd_pending.toLocaleString()}
				</td>
			</tr>
			<tr>
				<th scope="row" class="px-4 py-2.5 text-left font-medium">Approved</th>
				<td class="px-4 py-2.5 text-right font-semibold tabular-nums">
					{summary.ytd_approved.toLocaleString()}
				</td>
			</tr>
			<tr>
				<th scope="row" class="px-4 py-2.5 text-left font-medium">
					<span class="block">Average approval speed</span>
					<span class="block text-xs font-normal text-muted-foreground">
						{summary.approval_sample_size === 0
							? 'No completed workflow history'
							: `${summary.approval_sample_size.toLocaleString()} completed workflow${summary.approval_sample_size === 1 ? '' : 's'}`}
					</span>
				</th>
				<td class="px-4 py-2.5 text-right font-semibold tabular-nums">
					{formatApprovalSpeed(summary.average_approval_hours)}
				</td>
			</tr>
		</tbody>
	</table>
	<p class="border-t bg-muted/30 px-4 py-2.5 text-xs leading-relaxed text-muted-foreground">
		{note}
	</p>
</section>
