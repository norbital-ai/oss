<script lang="ts">
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import { formatCalendarDate } from './display-formatters.js';

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

	let { title, asOfDate, summary, pendingLabel, note }: Props = $props();

	const { t } = useI18n<TenantI18nKeys>();

	const effectivePendingLabel = $derived(pendingLabel ?? t('component.yet_to_approve'));

	const headingId = $props.id();

	function formatApprovalSpeed(hours: number | null): string {
		if (hours == null) return t('component.not_tracked');
		if (hours < 24) return t('component.hours_short', { hours: hours.toFixed(hours < 10 ? 1 : 0) });
		const days = hours / 24;
		return t('component.days_short', { days: days.toFixed(days < 10 ? 1 : 0) });
	}
</script>

<section class="rounded-lg border bg-card shadow-card" aria-labelledby={headingId}>
	<div class="border-b px-4 py-3">
		<h3 id={headingId} class="text-sm font-semibold">{title}</h3>
		<p class="mt-0.5 text-xs text-muted-foreground">
			{t('component.ytd_through', { date: formatCalendarDate(asOfDate) })}
		</p>
	</div>
	<!-- stupidity:allow UI3 -- this is a derived three-row analytical summary, not collection data. -->
	<table class="w-full table-fixed text-sm">
		<thead class="sr-only">
			<tr>
				<th>{t('component.metric')}</th>
				<th>{t('component.ytd_result')}</th>
			</tr>
		</thead>
		<tbody class="divide-y">
			<tr>
				<th scope="row" class="w-2/3 px-4 py-2.5 text-left font-medium">
					{effectivePendingLabel}
				</th>
				<td class="px-4 py-2.5 text-right font-semibold tabular-nums">
					{summary.ytd_pending.toLocaleString()}
				</td>
			</tr>
			<tr>
				<th scope="row" class="px-4 py-2.5 text-left font-medium">{t('component.approved')}</th>
				<td class="px-4 py-2.5 text-right font-semibold tabular-nums">
					{summary.ytd_approved.toLocaleString()}
				</td>
			</tr>
			<tr>
				<th scope="row" class="px-4 py-2.5 text-left font-medium">
					<span class="block">{t('component.average_approval_speed')}</span>
					<span class="block text-xs font-normal text-muted-foreground">
						{summary.approval_sample_size === 0
							? t('component.no_workflow_history')
							: t('component.completed_workflows', {
									count: summary.approval_sample_size.toLocaleString(),
									s: summary.approval_sample_size === 1 ? '' : 's'
								})}
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
