<!--
	Local workspace alerts configuration and recent alert history inside the workspace Command Center.
	Adopts the same threshold + per-key repeat cooldown + transactional email delivery mechanism as
	the Realm Command Center, alongside active workspace administrator Inbox notifications.
-->
<script lang="ts">
	import { Effect } from 'effect';
	import { Badge, Button, EmptyState, Icon, Input, Spinner, TableSkeleton, toast } from '@norbital-ai/ui';
	import { fork, observe_once } from '@norbital-ai/ui/effect';
	import { Scroll } from '@norbital-ai/ui/layout';
	import { date_time } from '../i18n.ts';
	import type { ShellApi, WorkspaceAlerts, WorkspaceAlertsState } from '../api-types.ts';

	let {
		api,
		t,
		locale
	}: {
		api: ShellApi;
		t: (key: string) => string;
		locale: string;
	} = $props();

	const alertsState = observe_once(() => api.alerts());
	let saving = $state(false);
	let testing = $state(false);
	let error = $state<string | null>(null);
	let statusMessage = $state<string | null>(null);

	let enabled = $state(false);
	let emailsText = $state('');
	let notifyAdmins = $state(true);
	let cooldownMinutes = $state('60');
	let automationFailed = $state(true);
	let integrationFailed = $state(true);
	let aiSpendEnabled = $state(true);
	let aiSpendThreshold = $state('80');
	let hydrated: WorkspaceAlertsState | undefined = undefined;

	$effect(() => {
		const current = alertsState.current;
		if (current === undefined || current === hydrated) return;
		hydrated = current;
		enabled = current.settings.enabled;
		emailsText = current.settings.emails.join(', ');
		notifyAdmins = current.settings.notify_admins;
		cooldownMinutes = String(current.settings.cooldown_minutes);
		automationFailed = current.settings.automation_failed;
		integrationFailed = current.settings.integration_failed;
		aiSpendEnabled = current.settings.ai_spend_threshold_pct !== null;
		aiSpendThreshold = String(current.settings.ai_spend_threshold_pct ?? 80);
	});

	const KIND_LABELS: Readonly<Record<string, string>> = {
		automation: 'Automation',
		integration: 'Integration',
		ai_spend: 'AI budget',
		test: 'Test'
	};

	const parseIntInRange = (raw: string, min: number, max: number): number | null => {
		const num = Number(raw.trim());
		return Number.isInteger(num) && num >= min && num <= max ? num : null;
	};

	const save = (event: SubmitEvent) => {
		event.preventDefault();
		error = null;
		statusMessage = null;
		const cooldown = parseIntInRange(cooldownMinutes, 1, 1440);
		if (cooldown === null) {
			error = t('Repeat cooldown must be between 1 and 1440 minutes.');
			return;
		}
		const threshold = aiSpendEnabled ? parseIntInRange(aiSpendThreshold, 1, 100) : null;
		if (aiSpendEnabled && threshold === null) {
			error = t('AI spend threshold must be between 1 and 100%.');
			return;
		}
		const emails = emailsText
			.split(',')
			.map((part) => part.trim())
			.filter((part) => part.length > 0);
		const payload: WorkspaceAlerts = {
			enabled,
			emails,
			notify_admins: notifyAdmins,
			cooldown_minutes: cooldown,
			automation_failed: automationFailed,
			integration_failed: integrationFailed,
			ai_spend_threshold_pct: threshold
		};
		saving = true;
		fork(
			api.save_alerts(payload).pipe(
				Effect.tap(() =>
					Effect.sync(() => {
						const msg = t('Workspace alert settings saved.');
						statusMessage = msg;
						toast.success(msg);
					})
				),
				Effect.andThen(alertsState.refetch()),
				Effect.catch((cause) =>
					Effect.sync(() => {
						error = cause.message;
					})
				),
				Effect.ensuring(
					Effect.sync(() => {
						saving = false;
					})
				)
			)
		);
	};

	const sendTest = () => {
		error = null;
		statusMessage = null;
		testing = true;
		fork(
			api.test_alert().pipe(
				Effect.tap((result) =>
					Effect.sync(() => {
						if (!result.sent) {
							error = result.reason ?? t('Could not deliver test alert.');
							return;
						}
						const parts: string[] = [];
						if (result.inbox > 0) parts.push(`${result.inbox} ${t('admin inbox')}`);
						if (result.emailed.length > 0)
							parts.push(`${t('emailed')} ${result.emailed.join(', ')}`);
						const msg = `${t('Test alert delivered')} (${parts.join(' · ')}).`;
						statusMessage = msg;
						toast.success(msg);
					})
				),
				Effect.andThen(alertsState.refetch()),
				Effect.catch((cause) =>
					Effect.sync(() => {
						error = cause.message;
					})
				),
				Effect.ensuring(
					Effect.sync(() => {
						testing = false;
					})
				)
			)
		);
	};

	const money = (usd: number) =>
		new Intl.NumberFormat(locale, {
			style: 'currency',
			currency: 'USD',
			maximumFractionDigits: usd > 0 && usd < 1 ? 4 : 2
		}).format(usd);
</script>

{#if alertsState.loading && alertsState.current === undefined}
	<TableSkeleton />
{:else if alertsState.error !== undefined && alertsState.current === undefined}
	<p role="alert" class="text-xs text-destructive">{alertsState.error.message}</p>
{:else if alertsState.current !== undefined}
	{@const snap = alertsState.current}
	<Scroll name="workspace-alerts" size="fill" layout="stack" gap="lg">
		<div class="flex max-w-3xl flex-col gap-5 pb-4 text-xs">
			<div class="flex flex-wrap items-start justify-between gap-3">
				<div class="flex flex-col gap-0.5">
					<div class="flex items-center gap-2">
						<h2 class="text-sm font-semibold">{t('Workspace alerts')}</h2>
						<Badge variant={snap.settings.enabled ? 'success' : 'outline'}>
							{t(snap.settings.enabled ? 'Enabled' : 'Paused')}
						</Badge>
					</div>
					<p class="text-meta">
						{t(
							'Receive notifications in administrator Inbox and by email when workspace automations, integrations, or monthly AI spend need attention.'
						)}
					</p>
				</div>
				<Button
					type="button"
					variant="outline"
					class="h-8 gap-1.5 px-3 text-xs"
					disabled={testing || saving}
					onclick={sendTest}
				>
					{#if testing}<Spinner class="size-3.5" />{:else}<Icon
							name="lucide:send"
							class="size-3.5"
						/>{/if}
					{t(testing ? 'Sending…' : 'Send test alert')}
				</Button>
			</div>

			{#if error !== null}
				<p
					role="alert"
					class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive"
				>
					{error}
				</p>
			{:else if statusMessage !== null}
				<p
					role="status"
					class="rounded-md border border-border bg-muted/40 px-3 py-2 text-foreground"
				>
					{statusMessage}
				</p>
			{/if}

			<form
				onsubmit={save}
				class="flex flex-col gap-4 rounded-lg border border-border bg-card/40 p-4"
			>
				<label class="flex items-start gap-2.5">
					<input type="checkbox" class="mt-0.5" bind:checked={enabled} />
					<span>
						<strong class="block font-medium text-foreground">{t('Enable workspace alerts')}</strong>
						<span class="text-meta">
							{t('Automatically dispatch alerts for the enabled triggers below.')}
						</span>
					</span>
				</label>

				<div class="grid gap-3 border-t border-border/60 pt-3">
					<span class="text-overline">{t('Delivery')}</span>
					<label class="flex items-start gap-2.5">
						<input type="checkbox" class="mt-0.5" bind:checked={notifyAdmins} />
						<span>
							<strong class="block font-medium text-foreground"
								>{t('Notify workspace administrators')}</strong
							>
							<span class="text-meta">
								{t('Posts alerts to active administrators’ Inbox and emails their addresses when no custom email list is entered.')}
								{#if snap.admin_emails.length > 0}
									<span class="mt-0.5 block font-mono">
										{snap.admin_emails.join(', ')}
									</span>
								{/if}
							</span>
						</span>
					</label>

					<div class="grid gap-3 sm:grid-cols-3">
						<label class="flex flex-col gap-1 sm:col-span-2">
							<span class="font-medium text-foreground">{t('Email recipients')}</span>
							<Input
								type="text"
								placeholder="ops@company.com, admin@company.com"
								bind:value={emailsText}
							/>
							<span class="text-meta">
								{t('Optional comma-separated addresses. Leave blank to email active administrators.')}
							</span>
						</label>
						<label class="flex flex-col gap-1">
							<span class="font-medium text-foreground">{t('Repeat cooldown (min)')}</span>
							<Input type="number" min="1" max="1440" required bind:value={cooldownMinutes} />
							<span class="text-meta">{t('Suppresses duplicate alerts per key.')}</span>
						</label>
					</div>
				</div>

				<div class="grid gap-3 border-t border-border/60 pt-3">
					<span class="text-overline">{t('Triggers')}</span>
					<label class="flex items-start gap-2.5">
						<input type="checkbox" class="mt-0.5" bind:checked={automationFailed} />
						<span>
							<strong class="block font-medium text-foreground">{t('Automation failures')}</strong>
							<span class="text-meta">
								{t('Alert when any scheduled, event, or manual automation finishes with an error.')}
							</span>
						</span>
					</label>

					<label class="flex items-start gap-2.5">
						<input type="checkbox" class="mt-0.5" bind:checked={integrationFailed} />
						<span>
							<strong class="block font-medium text-foreground"
								>{t('Integration & sync failures')}</strong
							>
							<span class="text-meta">
								{t('Alert when outbound messages fail permanently or a sync read/write fails.')}
							</span>
						</span>
					</label>

					<div class="flex flex-col gap-2">
						<label class="flex items-start gap-2.5">
							<input type="checkbox" class="mt-0.5" bind:checked={aiSpendEnabled} />
							<span>
								<strong class="block font-medium text-foreground"
									>{t('Monthly AI budget threshold')}</strong
								>
								<span class="text-meta">
									{#if snap.ai_monthly_cap !== null && snap.ai_monthly_cap > 0}
										{t('Current month')}: {money(snap.ai_monthly_spent)} / {money(
											snap.ai_monthly_cap
										)} ({Math.round((snap.ai_monthly_spent / snap.ai_monthly_cap) * 100)}%)
									{:else}
										{t('Set a workspace monthly AI limit in Settings → Organization → Assistant to activate budget alerts.')}
									{/if}
								</span>
							</span>
						</label>
						{#if aiSpendEnabled}
							<label class="ml-6 flex max-w-44 flex-col gap-1">
								<span class="text-meta">{t('Alert threshold (%)')}</span>
								<Input
									type="number"
									min="1"
									max="100"
									required
									bind:value={aiSpendThreshold}
								/>
							</label>
						{/if}
					</div>
				</div>

				<div class="flex items-center justify-end gap-2 border-t border-border/60 pt-3">
					<Button type="submit" class="h-8 px-3 text-xs" disabled={saving}>
						{#if saving}<Spinner class="size-3.5" />{/if}
						{t(saving ? 'Saving…' : 'Save alert settings')}
					</Button>
				</div>
			</form>

			<section class="flex flex-col gap-2" aria-label={t('Recent alerts')}>
				<div class="flex items-center justify-between gap-2">
					<h3 class="text-xs font-semibold text-foreground">{t('Recent alerts')}</h3>
					<Badge variant="outline" class="tabular-nums">{snap.history.length}</Badge>
				</div>
				{#if snap.history.length === 0}
					<EmptyState
						variant="inset"
						icon="alert"
						title={t('No alerts triggered yet.')}
						hint={t('Triggered alerts and test deliveries appear here.')}
					/>
				{:else}
					<div class="divide-y divide-border rounded-lg border border-border bg-card/30">
						{#each snap.history as item (item.id)}
							<div class="flex flex-col gap-1 px-3 py-2.5">
								<div class="flex flex-wrap items-center justify-between gap-2">
									<div class="flex flex-wrap items-center gap-1.5">
										<Badge variant={item.kind === 'test' ? 'outline' : 'warning'}>
											{t(KIND_LABELS[item.kind] ?? item.kind)}
										</Badge>
										<span class="font-medium text-foreground">{item.title}</span>
									</div>
									<span class="text-meta tabular-nums">{date_time(item.at, locale)}</span>
								</div>
								<p class="text-meta whitespace-pre-line">{item.detail}</p>
								<div class="text-meta flex flex-wrap gap-3">
									{#if item.inbox > 0}
										<span>{t('Inbox')}: {item.inbox}</span>
									{/if}
									{#if item.emailed.length > 0}
										<span>{t('Emailed')}: {item.emailed.join(', ')}</span>
									{/if}
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</section>
		</div>
	</Scroll>
{/if}
