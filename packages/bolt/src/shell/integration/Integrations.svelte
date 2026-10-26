<!--
	Settings → Integrations: each envoy's channel as one-click connectors (`Envoys`), then the other `sys_integration`
	rows with their account, state and owner. Each connection appears once. An agent channel's card owns its connection
	(pair, test, reconnect, disconnect), so its Settings sheet holds only its configuration and messages; a table row's
	sheet holds the connection too, as its first tab. New makes one of any definition (a member's own account where the driver syncs one). A row opens its
	sheet: the generic setup over the host's verbs (provider choice, pairing, test, reconnect, disconnect), then the
	instance's own fields (name, active, the envoy answering a workspace conversation instance, the configuration its
	definition declares) and, for a conversation, its raw messages. Every write is the model's native form or act.
-->
<script lang="ts">
	import { fork, observeOnce } from '@norbital-ai/ui/effect';
	import { Effect, Predicate } from 'effect';
	import { Decimal } from '@norbital-ai/std/decimal';
	import type { Value } from '@norbital-ai/std/kind';
	import { watch } from 'runed';
	import {
		Button,
		Combobox,
		confirmAction,
		Dialog,
		Editor,
		Field,
		Form,
		format,
		formatHandle,
		StateBadge,
		Table,
		Tabs,
		type FieldEditor
	} from '@norbital-ai/ui';
	import type { InputFields } from '../../decl/fields.ts';
	import { configurationDefaults } from '../../decl/runtime/integration.ts';
	import type { InstanceState } from '../../protocol/instance-status.ts';
	import IntegrationSetup from '../../page/IntegrationSetup.svelte';
	import { driverLabel, statusLabel, type IntegrationSetupEntry } from './setup.ts';
	import type { InstanceMessage } from '../api-types.ts';
	import type { Settings } from '../settings/data.ts';
	import type { ShellBolt } from '../runtime.ts';
	import type { ShellApi } from '../api-types.ts';
	import DetailSheet from '../DetailSheet.svelte';
	import Envoys from './Envoys.svelte';

	let {
		api,
		bolt,
		t,
		settings,
		locale,
		integrationSetups,
		reload
	}: {
		api: ShellApi;
		bolt: ShellBolt;
		t: (key: string) => string;
		settings: Settings;
		locale: string;
		/** The definitions' own setup components (`integration/<name>/+integration.svelte`), drawn in place of the generic setup. */
		integrationSetups?: { readonly [integration: string]: IntegrationSetupEntry } | undefined;
		/** Re-reads the settings after a write. */
		reload: () => Effect.Effect<void>;
	} = $props();

	type Instance = Settings['instances'][number];
	type Definition = Settings['integrations'][number];
	const objectValue = (v: Value | undefined): v is Readonly<Record<string, Value>> =>
		Predicate.isObject(v) && !(v instanceof Decimal);
	const obj = (v: Value | undefined): { readonly [k: string]: Value } => (objectValue(v) ? v : {});
	const str = (v: Value | undefined) => (v === null || v === undefined ? '' : String(v));
	const when = (v: Value | undefined) =>
		typeof v === 'string' && v !== ''
			? format({ kind: 'instant' }, v, { locale: bolt.locale })
			: '—';
	const definition = (name: Value | undefined): Definition | undefined =>
		settings.integrations.find((d) => d.name === name);
	const memberName = (id: string | null) => {
		const u = settings.members.find((x) => x['id'] === id);
		return str(u?.['name']) || str(u?.['email']) || str(id);
	};
	const envoyName = (id: string) => settings.envoys.find((e) => e.id === id)?.name ?? id;
	/** The state the host last recorded: only durable transitions reach the row; the open sheet follows the live stream. */
	const stored = (i: Instance): InstanceState => {
		const s = obj(i.status)['state'];
		return s === 'connected' || s === 'error' ? s : 'unpaired';
	};
	const rows = $derived(
		settings.instances
			.filter((i) => !settings.envoys.some((e) => e.id === i.envoy))
			.map((i) => ({
				id: i.id,
				name: i.name,
				integration: i.integration,
				account: str(obj(i.status)['account']),
				state: i.active ? statusLabel({ state: stored(i), stored: false }, t) : t('Paused'),
				used: i.envoy !== null ? envoyName(i.envoy) : i.owner !== null ? memberName(i.owner) : ''
			}))
	);
	const connectionsTitle = $derived(
		t(settings.envoys.length > 0 ? 'Other connections' : 'Connections')
	);

	// ── the open instance: its sheet, and its client (one per instance, so its stream is held while the sheet is open) ──
	let open = $state<string | null>(null);
	const current = $derived(settings.instances.find((i) => i.id === open));
	const client = $derived(open === null ? null : api.integration(open));
	let error = $state<string | null>(null);
	watch(
		() => open,
		() => {
			error = null;
		}
	);
	function remove(i: Instance): void {
		fork(
			confirmAction({
				title: t('Delete {name}?').replace('{name}', i.name),
				body: t('Its credentials, sync progress, conversations and messages are deleted with it.'),
				confirmLabel: t('Delete'),
				cancelLabel: t('Cancel'),
				destructive: true
			}).pipe(
				Effect.flatMap((confirmed) =>
					confirmed
						? bolt.act('sys_integration.delete', { target: i.id }).pipe(
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
	const messages = observeOnce(() => {
		const scope = messageScope;
		const before = messageRequest?.scope === scope ? messageRequest.before : undefined;
		return scope.instance === null
			? null
			: scope.api
					.instanceMessages(scope.instance, before)
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

	const syncHealth = observeOnce(() => {
		const instance = current;
		return instance === undefined || definition(instance.integration)?.syncs !== true
			? null
			: api.instanceSyncHealth(instance.id);
	});
	let replaying = $state<string | null>(null);
	function replayDead(): void {
		const instance = current?.id;
		if (instance === undefined || replaying === instance) return;
		replaying = instance;
		error = null;
		fork(
			api.replayInstanceSync(instance).pipe(
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

	let creating = $state(false);
	const labelOf = (name: string, f: InputFields[string]) =>
		f.label ?? name.replace(/_/g, ' ').replace(/^\w/, (x) => x.toUpperCase());
</script>

<!-- `configuration` by its definition's fields, each by its kind's editor: the stored value, which starts as the definition's defaults -->
{#snippet configuration(fields: InputFields, { value, onChange, id }: FieldEditor)}
	<div class="flex flex-col gap-3" {id}>
		{#each Object.entries(fields) as [name, f] (name)}
			<div class="flex flex-col gap-1 text-sm">
				<label class="text-label" for={`${id}-${name}`}
					>{t(labelOf(name, f))}{#if f.optional === true}
						<span class="text-meta">({t('optional')})</span>{/if}</label
				>
				<Editor
					id={`${id}-${name}`}
					{name}
					kind={f}
					value={obj(value)[name] ?? null}
					onChange={(v) => onChange({ ...obj(value), [name]: v })}
				/>
				{#if f.help}<p class="text-meta">{t(f.help)}</p>{/if}
			</div>
		{/each}
	</div>
{/snippet}

{#if settings.envoys.length > 0}<Envoys
		{api}
		{bolt}
		{settings}
		{t}
		{locale}
		onManage={(instance) => (open = instance)}
		{reload}
	/>{/if}

<section class="flex flex-col gap-2" data-integration-connections>
	{#if rows.length > 0}
		<Table
			of={rows}
			key="integration-instances"
			onOpen={(row) => {
				open = row.id;
			}}
			toolbar={{
				title: connectionsTitle,
				description: t('External accounts used by this workspace or its members.'),
				new: () => (creating = true)
			}}
			columns={[
				{ field: 'name', label: t('Name') },
				{ field: 'integration', label: t('Integration') },
				{ field: 'account', label: t('Account') },
				{ field: 'state', label: t('State') },
				{ field: 'used', label: t('Used by') }
			]}
		>
			{#snippet empty()}<p class="text-sm text-muted-foreground">
					{t('No connections match your search.')}
				</p>{/snippet}
		</Table>
	{:else}
		<header class="flex items-center justify-between gap-3">
			<h2 class="text-sm font-medium">{connectionsTitle}</h2>
			<Button size="sm" onclick={() => (creating = true)}>{t('New connection')}</Button>
		</header>
		<p class="text-meta">
			{t(settings.envoys.length > 0 ? 'No other connections yet.' : 'No connections yet.')}
		</p>
	{/if}
</section>

{#if current !== undefined}
	{@const i = current}
	{@const d = definition(i.integration)}
	{@const channel = settings.envoys.some((e) => e.id === i.envoy)}
	<DetailSheet
		title={i.name}
		onClose={() => (open = null)}
		acts={i.named ? [] : [{ label: t('Delete'), variant: 'destructive', run: () => remove(i) }]}
		fields={[
			{ label: t('Integration'), value: i.integration },
			{ label: t('Driver'), value: driverLabel(d?.driver ?? '') },
			{ label: t('Workspace connection'), value: i.named ? i.id : undefined },
			{ label: t('Owner'), value: i.owner === null ? undefined : memberName(i.owner) },
			...(d?.sends === true
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
	>
		{#if error !== null}<p role="alert" class="text-sm text-destructive" data-instance-error>
				{error}
			</p>{/if}
		<div class="border-t pt-3">
			{#snippet connectionTab()}
				<!-- a durable move (connected, unpaired, error) re-reads the rows, so the table never shows the old state -->
				{#if client !== null}<IntegrationSetup
						{client}
						setup={integrationSetups?.[i.integration]}
						onStateChange={(state, previous) => {
							if (
								previous !== undefined &&
								state !== previous &&
								(state === 'connected' || state === 'unpaired' || state === 'error')
							)
								fork(reload());
						}}
						{t}
						{locale}
					/>{/if}
			{/snippet}
			{#snippet syncTab()}
				<div class="flex flex-col gap-3 text-sm" data-instance-sync>
					<div class="flex items-center justify-between gap-3">
						<h3 class="font-medium">{t('Sync health')}</h3>
						<Button
							size="sm"
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
						{#if health.dead > 0}<div class="flex flex-col items-start gap-2 border-t pt-3">
								<p class="text-meta">
									{t('Retry deliveries that stopped after repeated failures.')}
								</p>
								<Button
									size="sm"
									variant="outline"
									disabled={replaying === i.id}
									onclick={replayDead}
									>{t(replaying === i.id ? 'Replaying…' : 'Replay dead letters')}</Button
								>
							</div>{/if}
					{:else if syncHealth.loading}<p class="text-meta">{t('Loading…')}</p>{/if}
				</div>
			{/snippet}
			{#snippet settingsTab()}
				{#snippet envoyEditor({ value, onChange, id }: FieldEditor)}
					<Combobox
						{id}
						size="sm"
						clearable
						placeholder={t('No envoy answers here')}
						aria-label={t('Envoy')}
						value={typeof value === 'string' ? value : null}
						options={settings.envoys.map((e) => ({
							value: e.id,
							label: e.name,
							description: t(e.audience === 'public' ? 'Public' : 'Private')
						}))}
						{onChange}
					/>
				{/snippet}
				{#snippet configurationEditor(e: FieldEditor)}{@render configuration(
						d?.configuration ?? {},
						e
					)}{/snippet}
				<Form
					of="sys_integration"
					mode="update"
					id={i.id}
					submit={t('Save')}
					onOutcome={() => fork(reload())}
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
						<Button
							size="sm"
							variant="ghost"
							disabled={messages.loading}
							onclick={() => fork(readLog())}>{t('Refresh')}</Button
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
												? formatHandle(d?.driver ?? '', x.sender ?? '', x.sender_name)
												: t('sent')}</span
										>
										<span class="min-w-0 truncate"
											>{x.kind === 'group'
												? (x.title ?? x.thread)
												: formatHandle(d?.driver ?? '', x.thread ?? '')}</span
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
								size="sm"
								variant="ghost"
								disabled={messages.loading}
								onclick={() => fork(readLog(true))}>{t('Older')}</Button
							>{/if}
					{/if}
				</div>
			{/snippet}
			<Tabs
				orientation="horizontal"
				value={channel ? 'settings' : 'connection'}
				tabs={[
					...(channel
						? []
						: [
								{
									name: 'connection',
									title: t('Connection'),
									icon: 'lucide:plug',
									body: connectionTab,
									keepAlive: true as const
								}
							]),
					{
						name: 'settings',
						title: t('Configuration'),
						icon: 'lucide:settings-2',
						body: settingsTab,
						keepAlive: true
					},
					...(d?.syncs === true
						? [
								{
									name: 'sync',
									title: t('Sync'),
									icon: 'lucide:refresh-cw',
									body: syncTab,
									keepAlive: true as const
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
									keepAlive: true as const
								}
							]
						: [])
				]}
			/>
		</div>
	</DetailSheet>
{/if}

<Dialog.Root
	open={creating}
	onOpenChange={(o) => {
		if (!o) creating = false;
	}}
>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<Dialog.Title>{t('Create integration instance')}</Dialog.Title>
			<Dialog.Description
				>{t('Pair it with its provider from its sheet once it is created.')}</Dialog.Description
			>
		</Dialog.Header>
		{#if creating}
			<Form
				of="sys_integration"
				mode="create"
				values={{ configuration: {} }}
				submit={t('Create integration instance')}
				onOutcome={(outcome) => {
					if (outcome.kind !== 'committed') return;
					creating = false;
					const created = outcome.records.find((record) => record.collection === 'sys_integration');
					fork(
						reload().pipe(
							Effect.tap(() =>
								Effect.sync(() => {
									if (created !== undefined) open = created.id;
								})
							)
						)
					);
				}}
			>
				{#snippet children(form)}
					{@const chosen = definition(form.get('integration'))}
					<!-- another definition takes its own configuration: the last one's values would be refused -->
					{#snippet definitionEditor({ value, onChange, id }: FieldEditor)}
						<Combobox
							{id}
							size="sm"
							aria-label={t('Integration definition')}
							placeholder={t('Choose an integration')}
							value={typeof value === 'string' ? value : null}
							options={settings.integrations.map((x) => ({
								value: x.name,
								label: `${x.name} · ${driverLabel(x.driver)}`,
								description: x.description
							}))}
							onChange={(name) => {
								onChange(name);
								form.set('configuration', configurationDefaults(definition(name)));
								if (definition(name)?.personal !== true) form.set('owner', null);
							}}
						/>
					{/snippet}
					{#snippet configurationEditor(e: FieldEditor)}{@render configuration(
							chosen?.configuration ?? {},
							e
						)}{/snippet}
					<Field name="integration" label={t('Integration')} editor={definitionEditor} />
					<Field name="name" label={t('Name')} />
					{#if chosen?.personal === true}
						<Field
							name="owner"
							label={t('Owner')}
							help={t(
								'A member’s own account only synchronizes: it never sends and no envoy answers on it.'
							)}
						/>
					{/if}
					{#if Object.keys(chosen?.configuration ?? {}).length > 0}<Field
							name="configuration"
							label={t('Configuration')}
							editor={configurationEditor}
						/>{/if}
				{/snippet}
			</Form>
		{/if}
	</Dialog.Content>
</Dialog.Root>
