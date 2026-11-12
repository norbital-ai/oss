<!-- The administrator's workspace connections or envoy channels, with the same native instance sheet. -->
<script lang="ts">
	import { fork, observe_once } from '@norbital-ai/ui/effect';
	import { Effect } from 'effect';
	import type { Snippet } from 'svelte';
	import type { Fields, Value } from '@norbital-ai/std/kind';
	import { watch } from 'runed';
	import {
		Button,
		Combobox,
		confirm_action,
		DescriptionHint,
		Editor,
		Field,
		Form,
		format,
		format_handle,
		StateBadge,
		Table,
		Tabs,
		value_object,
		type FieldEditor
	} from '@norbital-ai/ui';
	import IntegrationCard from '../../page/IntegrationCard.svelte';
	import { humanise_word } from '../i18n.ts';
	import { driverLabel, workspaceConnection, type IntegrationSetupEntry } from './setup.ts';
	import type { InstanceMessage } from '../api-types.ts';
	import type { Settings } from '../settings/data.ts';
	import type { ShellBolt } from '../runtime.ts';
	import type { ShellApi } from '../api-types.ts';
	import Envoys from './Envoys.svelte';
	import type { SystemUiIntent } from '../../protocol/system-ui.ts';

	let {
		api,
		bolt,
		t,
		settings,
		locale,
		integration_setups,
		reload,
		connections = false,
		configuration = null
	}: {
		api: ShellApi;
		bolt: ShellBolt;
		t: (key: string) => string;
		settings: Settings;
		locale: string;
		/** The definitions' own setup components (`integration/<name>/+integration.svelte`), drawn in place of the generic setup. */
		integration_setups?: { readonly [integration: string]: IntegrationSetupEntry } | undefined;
		/** Re-reads the settings after a write. */
		reload: () => Effect.Effect<void>;
		connections?: boolean;
		configuration?: SystemUiIntent | null;
	} = $props();

	type Instance = Settings['instances'][number];
	type Definition = Settings['integrations'][number];
	const obj = (v: Value | undefined): { readonly [k: string]: Value } => (value_object(v) ? v : {});
	const str = (v: Value | undefined) => (v === null || v === undefined ? '' : String(v));
	const when = (v: Value | undefined) =>
		typeof v === 'string' && v !== ''
			? format({ kind: 'instant' }, v, { locale: bolt.locale })
			: '—';
	const definition = (name: Value | undefined): Definition | undefined =>
		settings.integrations.find((d) => d.name === name);
	const rows = $derived(
		settings.instances.filter(workspaceConnection).map((instance) => ({
			id: instance.id,
			name: instance.name,
			driver: driverLabel(definition(instance.integration)?.driver ?? instance.integration),
			state: !instance.active ? 'paused' : str(obj(instance.status)['state'])
		}))
	);
	const memberName = (id: string | null) => {
		const u = settings.members.find((x) => x['id'] === id);
		return str(u?.['name']) || str(u?.['email']) || str(id);
	};
	// ── the open instance: its sheet, and its client (one per instance, so its stream is held while the sheet is open) ──
	let open = $state<string | null>(null);
	let creating = $state(false);
	let creating_definition = $state<string | null>(null);
	const new_definition = $derived(settings.integrations.find((item) => item.name === creating_definition));
	let configured = $state<string | null>(null);
	watch([() => configuration, () => settings], ([intent, current]) => {
		if (intent?.request.capability === 'integration.create' && connections && configured !== intent.key) {
			configured = intent.key;
			creating_definition = null;
			creating = true;
			return;
		}
		if (
			intent === null ||
			configured === intent.key ||
			intent.request.capability !== 'integration.manage'
		)
			return;
		const record = intent.request.record;
		if (
			current.instances.some(
				(instance) => instance.id === record && workspaceConnection(instance) === connections
			)
		) {
			configured = intent.key;
			open = record;
		}
	});
	const current = $derived(settings.instances.find((i) => i.id === open));
	const offers = observe_once(() => api.integration_offers());
	const setup_entry = $derived(current === undefined ? undefined : integration_setups?.[current.integration]);
	const setup_module = $derived(setup_entry?.load());
	let active_tab = $state('connection');
	let error = $state<string | null>(null);
	watch(
		() => open,
		() => {
			error = null;
			active_tab = 'connection';
		}
	);
	function remove(i: Instance): void {
		fork(
			confirm_action({
				title: t('Delete {name}?').replace('{name}', i.name),
				body: t('Its credentials, sync progress, conversations and messages are deleted with it.'),
				confirm_label: t('Delete'),
				cancel_label: t('Cancel'),
				destructive: true
			}).pipe(
				Effect.flatMap((confirmed) =>
					confirmed
						? bolt.act({ 'sys_integration.delete': [{ target: { id: i.id, revision: i.revision } }] }).pipe(
								Effect.tap((outcome) =>
									Effect.sync(() => {
										if (outcome.kind === 'committed') open = null;
									})
								),
								Effect.andThen(reload())
							)
						: Effect.void
				)
			),
			(cause) => {
				error = cause.message;
			}
		);
	}

	// ── newest-first raw messages; the resource owns cancellation and failures, the window owns appended pages ──
	const conversation = $derived(
		current !== undefined && definition(current.integration)?.conversation === true
			? current.id
			: null
	);
	const messageScope = $derived({ api, instance: conversation });
	let messageRequest = $state.raw<{ scope: typeof messageScope; before?: string } | undefined>();
	let messageWindow = $state.raw<
		{ scope: typeof messageScope; rows: InstanceMessage[]; more: boolean } | undefined
	>();
	const log = $derived(messageWindow?.scope === messageScope ? messageWindow : undefined);
	const messages = observe_once(() => {
		const scope = messageScope;
		const before = messageRequest?.scope === scope ? messageRequest.before : undefined;
		return scope.instance === null
			? null
			: scope.api
					.instance_messages(scope.instance, before)
					.pipe(Effect.map((rows) => ({ scope, before, rows })));
	});
	watch(
		() => messages.current,
		(answer) => {
			if (answer === undefined) return;
			messageWindow = {
				scope: answer.scope,
				rows:
					answer.before === undefined ? [...answer.rows] : [...(log?.rows ?? []), ...answer.rows],
				more: answer.rows.length === 100
			};
		}
	);
	const readLog = (older = false) =>
		Effect.sync(() => {
			if (messages.loading) return;
			const before = older ? log?.rows.at(-1)?.seq : undefined;
			if (older && before === undefined) return;
			messageRequest = { scope: messageScope, ...(before === undefined ? {} : { before }) };
		});

	const syncHealth = observe_once(() => {
		const instance = current;
		return instance === undefined || definition(instance.integration)?.syncs !== true
			? null
			: api.instance_sync_health(instance.id);
	});
	let replaying = $state<string | null>(null);
	function replaySync(): void {
		const instance = current?.id;
		if (instance === undefined || replaying === instance) return;
		replaying = instance;
		error = null;
		fork(
			api.replay_instance_sync(instance).pipe(
				Effect.andThen(syncHealth.refetch()),
				Effect.ensuring(
					Effect.sync(() => {
						if (replaying === instance) replaying = null;
					})
				)
			),
			(cause) => {
				if (open === instance) error = cause.message;
			}
		);
	}

	const configuration_text = (definition: string, name: string, part: 'fields' | 'help') => {
		const key = `integrations.${definition}.configuration.${part}.${name}`;
		const text = bolt.t(key);
		return text === key ? undefined : text;
	};
	const labelOf = (definition: string, name: string) =>
		configuration_text(definition, name, 'fields') ??
		humanise_word(name);
</script>

<!-- `configuration` by its definition's fields, each by its kind's editor: the stored value, which starts as the definition's defaults -->
{#snippet configurationFields(definition: string, fields: Fields, { value, on_change, id }: FieldEditor)}
	<div class="flex flex-col gap-3" {id}>
		{#each Object.entries(fields) as [name, f] (name)}
			{@const help = configuration_text(definition, name, 'help')}
			<div class="flex flex-col gap-1 text-sm">
				<div class="flex min-w-0 items-center gap-1">
					<label class="text-label" for={`${id}-${name}`}
						>{labelOf(definition, name)}{#if f.optional === true}
							<span class="text-meta">({t('optional')})</span>{/if}</label
					>
					{#if help}<DescriptionHint text={help} />{/if}
				</div>
				<Editor
					id={`${id}-${name}`}
					{name}
					kind={f}
					value={obj(value)[name] ?? null}
					on_change={(v) => on_change({ ...obj(value), [name]: v })}
				/>
			</div>
		{/each}
	</div>
{/snippet}

{#if current === undefined}
{#if connections}
	{#snippet stateCell({ row }: { row: (typeof rows)[number] })}
		<StateBadge
			state={row.state}
			label={t(
				row.state === 'paused'
					? 'Paused'
					: row.state === 'connected'
						? 'Connected'
						: row.state === 'error'
							? 'Needs attention'
							: ['connecting', 'pairing', 'reconnecting'].includes(row.state)
								? 'Connecting'
								: 'Off'
			)}
		/>
	{/snippet}
	{#if !creating}<Table
		of={rows}
		key="workspace-connections"
		on_open={(row) => (open = row.id)}
		toolbar={{ title: false, new: () => { creating_definition = null; creating = true; }, export: false }}
		columns={[
			{ field: 'name', label: t('Name') },
			{ field: 'driver', label: t('Driver') },
			{ field: 'state', label: t('Status'), cell: stateCell }
		]}
	/>{/if}
	{#if creating}
		<section class="mt-4 space-y-4 rounded-lg border bg-card p-4" data-connection-create>
			<div class="flex items-start justify-between gap-3">
				<div><h3 class="text-sm font-medium">{t('New connection')}</h3><p class="mt-1 text-xs text-muted-foreground">{t('Choose an integration, name the account, then pair its provider.')}</p></div>
				<Button variant="ghost" onclick={() => { creating = false; }}>{t('Cancel')}</Button>
			</div>
				<Combobox aria-label={t('Integration')} placeholder={t('Choose integration')}
					options={settings.integrations.map((item) => ({ value: item.name, label: t(humanise_word(item.name)), description: item.description }))}
					value={creating_definition} on_change={(next) => { creating_definition = next; }} />
				{#if new_definition !== undefined}
					{@const creating_fields = new_definition.configuration}
					{#key new_definition.name}
						<Form of="sys_integration" mode="create" values={{ integration: new_definition.name }} submit={t('Create connection')}
							on_outcome={(outcome) => {
								if (outcome.kind !== 'committed') return;
								const record = outcome.records.find((row) => row.model === 'sys_integration');
								if (record === undefined) return;
								creating = false;
								open = record.id;
								fork(reload());
							}}>
							<Field name="name" label={t('Name')} />
							{#if Object.keys(creating_fields).length > 0}
								<Field name="configuration" label={t('Configuration')}>
									{#snippet editor(field)}{@render configurationFields(new_definition.name, creating_fields, field)}{/snippet}
								</Field>
							{/if}
						</Form>
					{/key}
				{/if}
		</section>
	{/if}
{:else}<Envoys
		{api}
		{bolt}
		{settings}
		{t}
		{locale}
		{configuration}
		on_manage={(instance) => (open = instance)}
		{reload}
	/>{/if}
{/if}

{#if current !== undefined}
	{@const i = current}
	{@const d = definition(i.integration)}
	{@const channel = settings.envoys.some((e) => e.id === i.envoy)}
	{@const details_fields = [
			{ label: t('Integration'), value: i.integration === i.name ? undefined : i.integration },
			{ label: t('Driver'), value: channel ? driverLabel(d?.driver ?? '') : undefined },
			{ label: t('Owner'), value: i.owner === null ? undefined : memberName(i.owner) },
			...(d?.conversation === true && d.sends
				? [
						{ label: t('Sent'), value: i.delivery.sent },
						{ label: t('Queued'), value: i.delivery.pending },
						{ label: t('Retrying'), value: i.delivery.retrying },
						{ label: t('Failed'), value: i.delivery.failed },
						{ label: t('Skipped'), value: i.delivery.skipped },
						{
							label: t('Next retry'),
							value: i.delivery.nextRetry === null ? undefined : when(i.delivery.nextRetry)
						},
						{ label: t('Error'), value: i.delivery.lastError ?? undefined }
					]
				: [])
		]}
	{#key i.id}
	<section class="flex min-w-0 flex-col gap-4" data-integration-management={i.id} tabindex="-1" aria-label={i.name}
		{@attach (element) => { element.scrollIntoView({ block: 'start' }); element.focus({ preventScroll: true }); }}>
		<div class="flex flex-wrap items-center justify-between gap-3">
			<div><Button variant="ghost" onclick={() => { open = null; }}>{t(connections ? 'Back to connections' : 'Back to envoys')}</Button><h3 class="mt-2 text-base font-medium">{i.name}</h3></div>
			<Button variant="ghost" onclick={() => remove(i)}>{t('Delete connection')}</Button>
		</div>
		<details class="text-xs text-muted-foreground">
			<summary class="cursor-pointer">{t('Activity and account details')}</summary>
			<dl class="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
				{#each details_fields.filter((field) => field.value !== undefined) as field (field.label)}
					<div><dt>{field.label}</dt><dd class="mt-0.5 text-sm text-foreground break-words">{field.value === null ? '—' : String(field.value)}</dd></div>
				{/each}
			</dl>
		</details>
		{#if error !== null}<p role="alert" class="text-sm text-destructive" data-instance-error>
				{error}
			</p>{/if}
		<div class={channel ? 'border-t pt-3' : undefined}>
			{#snippet connectionTab()}
				{@const offer = offers.current?.find((item) => item.integration === i.integration)}
				{#if offers.error !== undefined}<p role="alert" class="text-sm text-destructive">{offers.error.message}</p>{/if}
				<div class="min-w-0">
					<IntegrationCard driver={d?.driver ?? i.integration} description={d?.description ?? ''}
						providers={i.owner === null ? (offer?.workspace ?? []) : (offer?.personal ?? [])}
						instance={{ id: i.id, status: i.status, active: i.active }} client={(id) => api.integration(id)}
						create={() => Effect.succeed(i.id)} setup={integration_setups?.[i.integration]}
						on_state_change={(state, previous) => {
							if (previous !== undefined && state !== previous && (state === 'connected' || state === 'unpaired' || state === 'error')) fork(reload());
						}} {t} {locale} />
				</div>
			{/snippet}
			{#snippet syncTab()}
				<div class="flex flex-col gap-3 text-sm" data-instance-sync>
					<div class="flex items-center justify-between gap-3">
						<h3 class="font-medium">{t('Sync health')}</h3>
						<Button
							variant="ghost"
							disabled={syncHealth.loading}
							onclick={() => fork(syncHealth.refetch())}>{t('Refresh')}</Button
						>
					</div>
					{#if syncHealth.error !== undefined}<p role="alert" class="text-destructive">
							{syncHealth.error.message}
						</p>{/if}
					{#if syncHealth.current}
						{@const health = syncHealth.current}
						<dl class="grid grid-cols-2 gap-x-4 gap-y-3">
							<div>
								<dt class="text-meta">{t('Last read')}</dt>
								<dd>{when(health.last_read_at)}</dd>
							</div>
							<div>
								<dt class="text-meta">{t('Read lag')}</dt>
								<dd class="tabular-nums">
									{health.lag_seconds === null
										? '—'
										: t('{seconds} s').replace(
												'{seconds}',
												String(Math.max(0, Math.round(health.lag_seconds)))
											)}
								</dd>
							</div>
							<div>
								<dt class="text-meta">{t('Last change')}</dt>
								<dd>{when(health.last_change_at)}</dd>
							</div>
							<div>
								<dt class="text-meta">{t('Last webhook')}</dt>
								<dd>{when(health.last_hint_at)}</dd>
							</div>
							<div>
								<dt class="text-meta">{t('Pending writes')}</dt>
								<dd class="tabular-nums">{health.pending}</dd>
							</div>
							<div>
								<dt class="text-meta">{t('Dead letters')}</dt>
								<dd class="tabular-nums">{health.dead}</dd>
							</div>
							<div>
								<dt class="text-meta">{t('Failed writes')}</dt>
								<dd class="tabular-nums">{health.failed}</dd>
							</div>
						</dl>
						{#if health.webhooks_quiet}<p role="status" class="text-warning">
								{t('Webhooks are quiet while reads still find changes.')}
							</p>{/if}
						{#if health.dead > 0 || health.initialization !== null}<div class="flex flex-col items-start gap-2 border-t pt-3">
								{#if health.initialization !== null}<p role="alert" class="text-destructive break-words">
										{t('Initial sync could not finish.')}{#if health.initialization.message !== null} {health.initialization.message}{/if}
									</p>{/if}
								<p class="text-meta">
									{t(health.initialization === null
										? 'Retry deliveries that stopped after repeated failures.'
										: 'Retry the initial sync and replay dead-lettered deliveries.')}
								</p>
								<Button variant="outline" disabled={replaying === i.id} onclick={replaySync}
									>{t(replaying === i.id ? 'Replaying…' : health.initialization === null ? 'Replay dead letters' : 'Retry sync')}</Button
								>
								{#each deadLetters.current ?? [] as letter (letter.id)}
									<div class="w-full rounded-sm border p-2 text-sm">
										<div class="flex flex-wrap items-center justify-between gap-2">
											<Button
												variant="link"
												onclick={() => openRecord(letter.model, letter.record)}
											>
												{letter.model} · {t('Revision')}
												{letter.revision}
											</Button>
											<Button
												variant="outline"
												disabled={retiring !== null}
												onclick={() => retireWrite(letter.id)}
											>
												{t(retiring === letter.id ? 'Retiring…' : 'Retire write')}
											</Button>
										</div>
										<p class="text-meta">{when(letter.at)} · {letter.message ?? t('Not set')}</p>
									</div>
								{/each}
								{#if deadLetters.error}<p role="alert" class="text-destructive">
										{deadLetters.error.message}
									</p>{/if}
							</div>{/if}
					{:else if syncHealth.loading}<p class="text-meta">{t('Loading…')}</p>{/if}
				</div>
			{/snippet}
			{#snippet settingsTab()}
				{#snippet envoyEditor({ value, on_change, id }: FieldEditor)}
					<Combobox
						{id}
						clearable
						placeholder={t('No envoy answers here')}
						aria-label={t('Envoy')}
						value={typeof value === 'string' ? value : null}
						options={settings.envoys.map((e) => ({
							value: e.id,
							label: e.name,
							description: t(e.audience === 'public' ? 'Public' : 'Private')
						}))}
						{on_change}
					/>
				{/snippet}
				{#snippet configurationEditor(e: FieldEditor)}{@render configurationFields(
						i.integration,
						d?.configuration ?? {},
						e
					)}{/snippet}
				<Form
					of="sys_integration"
					mode="update"
					id={i.id}
					submit={t('Save')}
					on_outcome={() => fork(reload())}
				>
					<Field name="name" label={t('Name')} />
					<Field name="active" label={t('Active')} />
					{#if d?.conversation === true && i.owner === null}<Field
							name="envoy"
							label={t('Envoy')}
							editor={envoyEditor}
						/>{/if}
					{#if Object.keys(d?.configuration ?? {}).length > 0}<Field
							name="configuration"
							label={t('Configuration')}
							editor={configurationEditor}
						/>{/if}
				</Form>
			{/snippet}
			{#snippet messagesTab()}
				<div class="flex flex-col gap-2 text-sm" data-instance-messages>
					<div class="flex items-center justify-between">
						<p class="text-xs text-muted-foreground">
							{t('Messages on this instance, newest first.')}
						</p>
						<Button variant="ghost" disabled={messages.loading} onclick={() => fork(readLog())}
							>{t('Refresh')}</Button
						>
					</div>
					{#if messages.error !== undefined}<p role="alert" class="text-xs text-destructive">
							{messages.error.message}
						</p>{/if}
					{#if log === undefined}
						{#if messages.loading}<p class="text-xs text-muted-foreground">{t('Loading…')}</p>{/if}
					{:else if log.rows.length === 0}
						<p class="text-xs text-muted-foreground">{t('No messages on this instance yet.')}</p>
					{:else}
						<ol class="flex flex-col gap-1.5">
							{#each log.rows as x (x.id)}
								<li
									class="rounded-md border border-border/70 px-2.5 py-1.5"
									data-direction={x.direction}
									data-instance-message={x.id}
								>
									<p class="flex items-center gap-2 text-xs text-muted-foreground">
										<span class="font-medium text-foreground"
											>{x.direction === 'inbound' ? '←' : '→'}
											{x.direction === 'inbound'
												? format_handle(d?.driver ?? '', x.sender ?? '', x.sender_name)
												: t('sent')}</span
										>
										<span class="min-w-0 truncate"
											>{x.kind === 'group'
												? (x.title ?? x.thread)
												: format_handle(d?.driver ?? '', x.thread ?? '')}</span
										>
										<span class="flex-1"></span>
										{#if x.direction === 'outbound' && x.status !== null}<StateBadge
												state={x.status}
												label={t(x.status)}
											/>{/if}
										<time class="tabular-nums">{when(x.at)}</time>
									</p>
									<p class="whitespace-pre-wrap">
										{x.text ?? ''}{#if x.files > 0}
											<span class="text-xs text-muted-foreground"
												>· {x.files} {t(x.files === 1 ? 'file' : 'files')}</span
											>{/if}
									</p>
									{#if x.error}<p
											class="text-xs {x.status === 'skipped'
												? 'text-muted-foreground'
												: 'text-destructive'}"
										>
											{x.error}
										</p>{/if}
									{#if x.delivery.length > 0}
										<!-- every report the provider (or bolt) made, oldest first (§5.9) -->
										<details class="text-xs" data-delivery-timeline>
											<summary class="cursor-pointer text-muted-foreground">{t('Delivery')}</summary
											>
											<ol class="mt-1 flex flex-col gap-0.5 border-l border-border/70 pl-2">
												{#each x.delivery as e, n (n)}
													<li data-delivery-kind={e.kind}>
														<span class="font-medium"
															>{t(e.kind === 'auto_replied' ? 'auto-replied' : e.kind)}</span
														>{#if e.presumed}
															<span class="text-muted-foreground">({t('presumed')})</span
															>{/if}{#if e.approximate}
															<span class="text-muted-foreground">({t('approximate')})</span>{/if}
														<time class="tabular-nums text-muted-foreground">{when(e.at)}</time>
														{#if e.provider !== 'bolt'}<span class="text-muted-foreground"
																>· {e.provider}</span
															>{/if}
														{#if e.code}<code class="text-muted-foreground">{e.code}</code>{/if}
														{#if e.reason}<span class="text-muted-foreground">— {e.reason}</span
															>{/if}
													</li>
												{/each}
											</ol>
										</details>
									{/if}
								</li>
							{/each}
						</ol>
						{#if log.more}<Button
								variant="ghost"
								disabled={messages.loading}
								onclick={() => fork(readLog(true))}>{t('Older')}</Button
							>{/if}
					{/if}
				</div>
			{/snippet}
			{#snippet instanceTabs(extra?: { title: string; body: Snippet })}
				<Tabs
					orientation="horizontal"
					bind:value={active_tab}
					tabs={[
						{ name: 'connection', title: t('Connection'), icon: 'lucide:plug', body: connectionTab, keep_alive: true },
						{
							name: 'settings',
							title: t('Configuration'),
							icon: 'lucide:settings-2',
							body: settingsTab,
							keep_alive: true
						},
						...(extra === undefined
							? []
							: [{ name: 'definition-settings', icon: 'lucide:sliders-horizontal', ...extra }]),
						...(d?.syncs === true
							? [
									{
										name: 'sync',
										title: t('Sync'),
										icon: 'lucide:refresh-cw',
										body: syncTab,
										keep_alive: true as const
									}
								]
							: []),
						...(d?.conversation === true
							? [
									{
										name: 'messages',
										title: t('Messages'),
										icon: 'lucide:messages-square',
										body: messagesTab,
										keep_alive: true as const
									}
								]
							: [])
					]}
				/>
			{/snippet}
			{#await setup_module}
				<p role="status" class="text-sm text-muted-foreground">{t('Loading…')}</p>
			{:then module}
				{#if module?.configuration_tab !== undefined}
					{#snippet extraTab()}<module.default />{/snippet}
					{@render instanceTabs({ title: t(module.configuration_tab), body: extraTab })}
				{:else}
					{@render instanceTabs()}
				{/if}
			{:catch}
				{@render instanceTabs()}
			{/await}
		</div>
	</section>
	{/key}
{/if}
