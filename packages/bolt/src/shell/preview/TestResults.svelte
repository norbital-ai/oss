<script lang="ts">
	import { Icon, Spinner } from '@norbital-ai/ui';
	import type { StudioTestRun } from '../studio/test-results.ts';
	let {
		run,
		t = (key: string) => key
	}: { run: StudioTestRun | undefined; t?: (key: string) => string } = $props();
	const label = $derived(
		run?.state === 'running'
			? 'Running tests'
			: run?.state === 'passed'
				? 'Tests passed'
				: run?.state === 'failed'
					? 'Tests failed'
					: run?.state === 'empty'
						? 'No tests ran'
						: 'Tests have not run'
	);
	const color = $derived(
		run?.state === 'running'
			? 'text-info'
			: run?.state === 'passed'
				? 'text-success'
				: run?.state === 'failed'
					? 'text-destructive'
					: 'text-muted-foreground'
	);
	const files = $derived(
		[...(run?.files ?? [])].sort(
			(a, b) => Number(b.state === 'failed') - Number(a.state === 'failed')
		)
	);
</script>

<div class="min-h-0 flex-1 overflow-y-auto p-3 text-xs" data-test-results={run?.state ?? 'not-run'}>
	<div
		role="status"
		aria-label={t(label)}
		aria-live="polite"
		class="flex items-center gap-2 font-medium {color}"
	>
		{#if run?.state === 'running'}<Spinner class="size-4" />{:else}<Icon
				name="lucide:flask-conical"
				class="size-4"
			/>{/if}
		{t(label)}
	</div>
	{#if run === undefined}
		<p class="mt-2 text-muted-foreground">
			{t('Run the tests from the toolbar.')}
		</p>
	{:else}
		{#if run.summary !== undefined}
			<dl class="my-4 flex flex-wrap gap-x-5 gap-y-2 tabular-nums">
				{#each [['Passed', run.summary.passed], ['Failed', run.summary.failed], ['Skipped', run.summary.skipped], ['Files', run.summary.files]] as [name, count]}
					<div>
						<dt class="text-muted-foreground">{t(String(name))}</dt>
						<dd class="text-base font-semibold">{count}</dd>
					</div>
				{/each}
				<div>
					<dt class="text-muted-foreground">{t('Duration')}</dt>
					<dd class="text-base font-semibold">{(run.summary.duration_ms / 1000).toFixed(2)}s</dd>
				</div>
			</dl>
		{/if}
		{#if run.error !== undefined}<pre
				class="my-3 whitespace-pre-wrap break-words rounded-md border border-destructive/30 bg-destructive/5 p-3 text-destructive">{run.error}</pre>{/if}
		{#if run.state === 'empty'}<p class="mt-3 text-muted-foreground">
				{t('Add tests before relying on this.')}
			</p>{/if}
		{#each files as file}
			<details open={file.state === 'failed'} class="mt-2 rounded-md border border-border">
				<summary class="cursor-pointer break-words p-3 font-medium"
					><span class={file.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'}
						>{t(
							file.state === 'failed' ? 'Failed' : file.state === 'passed' ? 'Passed' : 'Skipped'
						)}</span
					>
					· {file.path}</summary
				>
				<div class="space-y-2 border-t border-border p-3">
					{#if file.error !== undefined}<pre
							class="whitespace-pre-wrap break-words text-destructive">{file.error}</pre>{/if}
					{#each file.tests as test}
						<div class="break-words">
							<span class={test.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'}
								>{t(
									test.state === 'passed'
										? 'Passed'
										: test.state === 'failed'
											? 'Failed'
											: 'Skipped'
								)}</span
							>
							· {test.name}
							{#if test.error !== undefined}<pre
									class="mt-1 whitespace-pre-wrap break-words text-destructive">{test.error}</pre>{/if}
						</div>
					{/each}
				</div>
			</details>
		{/each}
		{#if run.truncated}<p class="mt-3 text-muted-foreground">
				{t('The result list was shortened. Totals include the full run.')}
			</p>{/if}
	{/if}
</div>
