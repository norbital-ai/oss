<!-- Settings: the organization, its integrations (envoys, API keys, MCP servers) and its secrets. -->
<script lang="ts">
	import { observe, fork } from '@norbital-ai/ui/effect';
	import { Effect, Option, Queue, Schema, Stream } from 'effect';
	import { Cluster, Scroll } from '@norbital-ai/ui/layout';
	import { watch } from '@norbital-ai/ui/behaviors';
	import {
		Badge,
		Button,
		Checkbox,
		Combobox,
		confirm_action,
		Dialog,
		EmptyState,
		Field,
		Form,
		format,
		Icon,
		Input,
		RecordShell,
		Section,
		Table,
		TableSkeleton,
		Tabs,
		type UiContext
	} from '@norbital-ai/ui';
	import type { Json } from '../../decl/values.ts';
	import { read_answer } from '../../protocol/read-answer.ts';
	import { WORKSPACE_SETTINGS_ID } from '../../system/settings.ts';
	import type { AiModel } from '@norbital-ai/host-api';
	import type { SettingsTab, ShellBoot } from '../nav.ts';
	import type { ShellBolt } from '../runtime.ts';
	import type { ShellApi } from '../api-types.ts';
	import type { Act } from '../Acts.svelte';
	import Acts from '../Acts.svelte';
	import { chosenLocale, usd } from '../i18n.ts';
	import { workspaceConnection, type IntegrationSetupEntry } from '../integration/setup.ts';
	import { SYSTEM_UI, type SystemUiIntent } from '../../protocol/system-ui.ts';
	import DetailSheet from '../DetailSheet.svelte';
	import Integrations from '../integration/Integrations.svelte';
	import Teams from './Teams.svelte';
	import SystemPage from '../SystemPage.svelte';
	import organizationBanner from '../assets/banners/organization.jpg';
	import integrationsBanner from '../assets/banners/integrations.jpg';
	import secretsBanner from '../assets/banners/secrets.jpg';

	let {
		ctx,
		api,
		bolt,
		t,
		tab,
		workspace,
		read_catalog,
		integration_setups,
		configuration = null
	}: {
		ctx: UiContext;
		api: ShellApi;
		bolt: ShellBolt;
		t: (key: string) => string;
		tab: SettingsTab;
		workspace: ShellBoot['workspace'];
		read_catalog: ShellBoot['read_catalog'];
		/** The definitions' own setup components (`integration/<name>/+integration.svelte`); the generic setup otherwise. */
		integration_setups?: { readonly [integration: string]: IntegrationSetupEntry } | undefined;
		configuration?: SystemUiIntent | null;
	} = $props();

	const TITLES: { readonly [k in SettingsTab]: string } = {
		organization: 'Organization',
		integrations: 'Integrations',
		secrets: 'Secrets'
	};
	const ICONS: { readonly [k in SettingsTab]: string } = {
		organization: 'concept:workspace',
		integrations: 'concept:integrations',
		secrets: 'lucide:key-round'
	};
	const DESCRIPTIONS: { readonly [k in SettingsTab]: string } = {
		organization: 'Workspace identity, branding and assistant limits.',
		integrations: 'Connections, envoys, API keys and MCP servers for this workspace.',
		secrets: 'Write-only values the workspace source reads by name.'
	};
	const BANNERS: { readonly [k in SettingsTab]: string } = {
		organization: organizationBanner,
		integrations: integrationsBanner,
		secrets: secretsBanner
	};
	let invalidate: (() => void) | undefined;
	const settings = observe(() => {
		const owner = api,
			source = bolt,
			catalog = read_catalog;
		const revisions = { sys_integration: { fields: ['revision'] } };
		const requested = Stream.callback<void>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					const refresh = () => {
						Queue.offerUnsafe(queue, undefined);
					};
					invalidate = refresh;
					refresh();
					return refresh;
				}),
				(refresh) =>
					Effect.sync(() => {
						if (invalidate === refresh) invalidate = undefined;
					})
			)
		);
		return Stream.merge(
			requested,
			source
				.observe(
					{ read: { m: 'query', a: [revisions] } },
					Schema.suspend(() => read_answer(catalog, revisions))
				)
				.pipe(Stream.map(() => undefined))
		).pipe(Stream.switchMap(() => Stream.fromEffect(owner.settings())));
	});
	const s = $derived(settings.current ?? null);
	const declaredIntegrations = $derived(
		new Set((s?.integrations ?? []).filter((d) => d.declared).map((d) => d.name))
	);
	const hasConnections = $derived(
		s !== null &&
			(s.integrations.some((d) => d.declared) ||
				s.instances.some((i) => workspaceConnection(i, s.envoy_channels, declaredIntegrations)))
	);
	let mutationError = $state<string | null>(null);
	const error = $derived(mutationError ?? settings.error?.message ?? null);
	// Invalidation switches only the inner read, keeping the open integration sheet mounted while it refreshes.
	const load = () =>
		Effect.suspend(() => (invalidate === undefined ? settings.refetch() : Effect.sync(invalidate)));
	/** One settings verb; the page re-reads after it. The answer's value (a new key) is returned. */
	const op = (name: string, input: { [key: string]: Json | undefined }) =>
		Effect.gen(function* () {
			mutationError = null;
			const body = Object.fromEntries(
				Object.entries(input).flatMap(([key, value]): [string, Json][] =>
					value === undefined ? [] : [[key, value]]
				)
			);
			const result = yield* Effect.result(api.settings_op(name, body));
			if (result._tag === 'Failure') {
				mutationError = result.failure.message;
				return undefined;
			}
			yield* load();
			return result.success;
		});
	const str = (v: Json | undefined) => (v === null || v === undefined ? '' : String(v));
	const when = (v: Json | undefined) =>
		typeof v === 'string' && v !== ''
			? format({ kind: 'instant' }, v, { locale: bolt.locale })
			: '—';
	const teams = $derived((s?.teams ?? []).map((r) => ({ value: r.id, label: r.name })));

	// ── rows: the settings read projected per table  ──
	const teamName = (id: string | null) => s?.teams.find((x) => x.id === id)?.name ?? '';
	const keys = $derived(
		(s?.keys ?? []).map((k) => ({
			id: k.id,
			name: k.name,
			prefix: `nbk_${k.prefix}_…`,
			team: teamName(k.team),
			created_at: k.created_at,
			last_used_at: k.last_used_at || null,
			revoked: k.revoked_at !== null
		}))
	);
	const remotes = $derived(
		(s?.mcp ?? []).map((remote) => ({
			id: remote.name,
			name: remote.name,
			url: str(remote.url),
			secrets: remote.secrets ?? []
		}))
	);
	const secrets = $derived(
		(s?.secrets ?? []).map((x) => ({
			id: x.name,
			label: x.label,
			name: x.name,
			status: x.set === null ? t('unknown') : x.set ? t('set') : t('unset'),
			set: x.set
		}))
	);

	// ── each row's actions: its table column and its detail sheet ──
	type Key = (typeof keys)[number];
	type Secret = (typeof secrets)[number];
	const keyActs = (k: Key): Act[] =>
		k.revoked
			? []
			: [
					{ label: t('Rotate'), run: () => fork(rotate(k.id)) },
					{
						label: t('Revoke'),
						run: () =>
							fork(
								confirm_action({
									title: t('Revoke the key {name}? Programs using it stop at once.').replace(
										'{name}',
										k.name
									),
									confirm_label: t('Revoke'),
									cancel_label: t('Cancel'),
									destructive: true
								}).pipe(
									Effect.flatMap((confirmed) =>
										confirmed ? op('revokeKey', { id: k.id }) : Effect.void
									)
								)
							),
						variant: 'destructive'
					}
				];
	const secretActs = (x: Secret): Act[] =>
		x.set === true
			? [{ label: t('Clear'), run: () => fork(op('clearSecret', { name: x.name })) }]
			: [];

	// ── the open row (one sheet at a time) and the create dialog ──
	type Open = { kind: 'key' | 'remote' | 'secret'; id: string };
	let open = $state<Open | null>(null);
	const show = (kind: Open['kind']) => (row: { id: string }) => {
		open = { kind, id: row.id };
	};
	let creating = $state(false);
	let submitting = $state(false);
	let form = $state({ keyName: '', keyTeam: '' });
	/** A new or rotated key, shown once in the dialog. */
	let issued = $state<string | null>(null);
	const Issued = Schema.Struct({ key: Schema.String });
	/** `issueKey` and `rotateKey` answer the new key, shown once. */
	const keyOf = (v: Json | undefined) =>
		Option.getOrNull(Option.map(Schema.decodeUnknownOption(Issued)(v), (answer) => answer.key));
	function create(): void {
		if (submitting) return;
		submitting = true;
		fork(
			op('issueKey', { name: form.keyName, team: form.keyTeam || null }).pipe(
				Effect.tap((v) =>
					Effect.sync(() => {
						if (v !== undefined) issued = keyOf(v);
					})
				),
				Effect.ensuring(
					Effect.sync(() => {
						submitting = false;
					})
				)
			)
		);
	}
	const rotate = Effect.fn('Settings.rotate')(function* (id: string) {
		const key = keyOf(yield* op('rotateKey', { id }));
		if (key !== null) {
			issued = key;
			creating = true;
		}
	});
	function closeDialog(): void {
		creating = false;
		issued = null;
		form = { keyName: '', keyTeam: '' };
	}

	// the workspace's logo, when the host lets an administrator edit it; a saved change reloads the shell's branding
	// svelte-ignore state_referenced_locally
	let brand = $state<{ logo: string | null }>({ logo: workspace.logo ?? null });
	let savingBrand = $state(false);
	const logoDirty = $derived(brand.logo !== (workspace.logo ?? null));
	/** The host's ceiling on an inline logo (a `data:` URL's length). */
	const LOGO_MAX = 256 * 1024;
	function pickLogo(file: File | undefined): void {
		if (file === undefined) return;
		const reader = new FileReader();
		reader.onload = () => {
			const url = String(reader.result);
			if (!/^data:image\/(png|svg\+xml|webp|jpeg);base64,/.test(url) || url.length > LOGO_MAX)
				mutationError = t('The logo must be a PNG, SVG, WebP or JPEG image of at most 256 KiB.');
			else {
				mutationError = null;
				brand.logo = url;
			}
		};
		reader.readAsDataURL(file);
	}
	const saveBrand = Effect.fn('Settings.saveBrand')(function* () {
		mutationError = null;
		savingBrand = true;
		try {
			const r = yield* Effect.result(api.organization(brand.logo));
			if (r._tag === 'Success') location.reload();
			else mutationError = r.failure.message;
		} finally {
			savingBrand = false;
		}
	});
	const hasWorkspaceModel = $derived(bolt.catalog['sys_workspace'] !== undefined);
	let secretValue = $state('');
	let integrationTab = $state<string | undefined>(undefined);
	let configured = $state<string | null>(null);
	watch([() => configuration, () => s], ([intent, settings]) => {
		if (intent === null || settings === null || configured === intent.key) return;
		configured = intent.key;
		const request = intent.request;
		const declared = new Set(settings.integrations.filter((d) => d.declared).map((d) => d.name));
		integrationTab =
			request.capability === 'integration.manage' &&
			settings.instances.some(
				(instance) =>
					instance.id === request.record &&
					workspaceConnection(instance, settings.envoy_channels, declared)
			)
				? 'connections'
				: SYSTEM_UI[request.capability].tab;
		if (request.capability === 'api_key.create') {
			form = { keyName: '', keyTeam: '' };
			issued = null;
			creating = true;
		} else if (request.capability === 'api_key.manage') open = { kind: 'key', id: request.record };
		else if (request.capability === 'mcp.configure') open = { kind: 'remote', id: request.record };
		else if (request.capability === 'secret.set') {
			open = { kind: 'secret', id: request.record };
			secretValue = '';
		}
	});
	// the assistant's runtime settings (Organization): read with the model catalogue, saved as one settings verb
	let assistant = $state<{
			monthly: string;
			member: string;
			policies: { [policy: string]: string };
			models: string[];
			system1: string | null;
			system2: string | null;
			system: {
				improve: boolean;
				automations: boolean;
				policies: readonly string[];
				monthly: string;
				task: string;
			};
		} | null>(null),
		catalog = $state<readonly AiModel[]>([]),
		deciders = $state<{ readonly models: readonly AiModel[]; readonly default: string }>({
			models: [],
			default: ''
		}),
		policyNames = $state<readonly string[]>([]),
		spentNow = $state(0);
	const loadAssistant = Effect.fn('Settings.assistant')(function* () {
		const r = yield* Effect.result(api.agent.models());
		const admin = r._tag === 'Success' ? r.success.admin : undefined;
		if (admin === undefined) return;
		catalog = admin.catalog;
		deciders = admin.deciders;
		spentNow = admin.spent;
		policyNames = admin.policies;
		assistant = {
			monthly: admin.settings.monthly?.toString() ?? '',
			member: admin.settings.member?.toString() ?? '',
			policies: Object.fromEntries(
				admin.policies.map((p) => [p, admin.settings.policies[p]?.toString() ?? ''])
			),
			models: [...admin.settings.models],
			system1: admin.settings.system1,
			system2: admin.settings.system2,
			system: {
				improve: admin.settings.system.improve,
				automations: admin.settings.system.automations,
				policies: admin.settings.system.policies,
				monthly: admin.settings.system.monthly?.toString() ?? '',
				task: admin.settings.system.task?.toString() ?? ''
			}
		};
	});
	/** A provider's models as picker rows, grouped by vendor, each with its listed price per million tokens. */
	const modelOptions = (models: readonly AiModel[]) =>
		models.map((model) => ({
			value: model.id,
			label: model.label,
			keywords: model.id,
			...(model.provider === undefined ? {} : { group: model.provider }),
			...(model.price === undefined
				? {}
				: { suffix: `${usd(model.price.input, 4)} / ${usd(model.price.output, 4)} ${t('per M tokens')}` })
		}));
	const labelOf = (models: readonly AiModel[], id: string) =>
		models.find((model) => model.id === id)?.label ?? id;
	watch(
		() => tab,
		(current) => {
			if (current === 'organization') fork(loadAssistant());
		}
	);
	const limit = (v: string) => (v.trim() === '' ? null : Math.max(0, Number(v)));
	const saveAssistant = Effect.fn('Settings.saveAssistant')(function* (a: NonNullable<typeof assistant>) {
		yield* op('set_agent', {
			monthly: limit(a.monthly),
			member: limit(a.member),
			policies: Object.fromEntries(
				Object.entries(a.policies).flatMap(([p, v]) => {
					const cap = limit(v);
					return cap === null ? [] : [[p, cap]];
				})
			),
			models: a.models,
			system1: a.system1,
			system2: a.system2,
			system: {
				improve: a.system.improve,
				automations: a.system.automations,
				policies: a.system.policies,
				monthly: limit(a.system.monthly),
				task: limit(a.system.task)
			}
		});
		if (mutationError === null) yield* loadAssistant();
	});
</script>

{#snippet at({ value }: { row: object; value: unknown })}<time class="tabular-nums"
		>{when(typeof value === 'string' ? value : null)}</time
	>{/snippet}
{#snippet keyCell({ row }: { row: Key; value: unknown })}<Acts acts={keyActs(row)} />{/snippet}
{#snippet secretCell({ row }: { row: Secret; value: unknown })}<Acts
		acts={secretActs(row)}
	/>{/snippet}
{#snippet mono({ value }: { row: object; value: unknown })}<code class="font-mono text-xs"
		>{String(value ?? '')}</code
	>{/snippet}

<SystemPage
	name={`settings-${tab}`}
	title={t(TITLES[tab])}
	icon={ICONS[tab]}
	banner={BANNERS[tab]}
	description={t(DESCRIPTIONS[tab])}
	{error}
	bounded
>
	{#if s === null}
		<div role="status" aria-busy="true" aria-label={t('Loading…')}>
			<TableSkeleton />
		</div>
	{:else if tab === 'organization'}
		<!-- one concern per tab; Workspace combines identity + branding inside the native RecordShell -->
		{#snippet save()}<Cluster gap="sm" justify="end" class="shrink-0 border-t pt-3"
				><Button type="submit">{t('Save')}</Button></Cluster
			>{/snippet}
		{#snippet logoControl(editing: boolean)}
			<div class="flex flex-col gap-1.5 text-sm">
				<span class="text-label">{t('Logo')}</span>
				<p class="text-meta">{t('The logo every member sees.')}</p>
				<div class="flex flex-wrap items-center gap-3 pt-1">
					{#if brand.logo !== null}
						<img
							src={brand.logo}
							alt={t('Logo')}
							class="size-10 rounded-sm border border-border bg-card object-contain p-1"
						/>
					{:else}
						<div
							class="grid size-10 place-items-center rounded-sm border border-dashed border-border text-muted-foreground"
						>
							<Icon name="lucide:image" class="size-4" />
						</div>
					{/if}
					{#if editing}
						<input
							type="file"
							accept="image/png,image/svg+xml,image/webp,image/jpeg"
							aria-label={t('Logo')}
							class="text-xs file:mr-2 file:rounded-sm file:border file:border-border file:bg-secondary file:px-2.5 file:py-1 file:text-xs file:font-medium file:text-foreground hover:file:bg-muted"
							onchange={(e) => pickLogo(e.currentTarget.files?.[0])}
						/>
						{#if brand.logo !== null}
							<Button type="button" variant="ghost" onclick={() => (brand.logo = null)}>
								{t('Remove logo')}
							</Button>
						{/if}
					{:else if brand.logo === null}
						<span class="text-meta">{t('Default mark')}</span>
					{/if}
				</div>
			</div>
		{/snippet}
		{#snippet workspaceReadonlyMeta()}
			<div class="grid gap-3 pt-1 sm:grid-cols-3">
				<div class="flex flex-col gap-1 text-sm">
					<span class="text-meta">{t('Workspace handle')}</span>
					<span class="font-mono text-xs text-foreground">{workspace.handle ?? '—'}</span>
				</div>
				<div class="flex flex-col gap-1 text-sm">
					<span class="text-meta">{t('Locale')}</span>
					<span class="text-foreground">{workspace.locale}</span>
				</div>
				<div class="flex flex-col gap-1 text-sm">
					<span class="text-meta">{t('Time zone')}</span>
					<span class="text-foreground">{workspace.tz}</span>
				</div>
			</div>
			<p class="text-meta">{t('The workspace handle is its identity in every address and record.')}</p>
		{/snippet}
		{#snippet workspaceFooterActions()}
			{#if workspace.organization && logoDirty}
				<Button
					type="button"
					variant="outline"
					disabled={savingBrand}
					onclick={() => fork(saveBrand())}
				>
					{savingBrand ? t('Saving…') : t('Save logo')}
				</Button>
			{/if}
		{/snippet}
		{#snippet workspaceTab()}
			{#if hasWorkspaceModel}
				<div class="flex h-full min-h-0 flex-1 flex-col">
					<RecordShell
						{ctx}
						of="sys_workspace"
						id={WORKSPACE_SETTINGS_ID}
						header={false}
						footer_actions={workspaceFooterActions}
						on_done={(outcome) => {
							if (outcome.kind === 'committed' && workspace.organization && logoDirty) {
								fork(saveBrand());
							}
						}}
					>
						{#snippet children(view)}
							{@const editing = view.mode === 'edit'}
							<Form
								{ctx}
								of="sys_workspace"
								mode="update"
								id={WORKSPACE_SETTINGS_ID}
								{...(view.mode !== 'create' ? { record: view.record } : {})}
								readonly={!editing}
								size="content"
							>
								<Section first name="identity" title={t('Identity')}>
									<Field
										{ctx}
										name="name"
										label={t('Display name')}
										help={t(
											'Shown in the sidebar and page titles. Leave blank to use the workspace handle.'
										)}
									>
										{#snippet editor(field)}
											<Input
												id={field.id}
												value={typeof field.value === 'string' ? field.value : ''}
												placeholder={workspace.handle ?? workspace.name}
												disabled={field.disabled}
												oninput={(event) =>
													field.on_change(
														event.currentTarget.value.trim() === ''
															? null
															: event.currentTarget.value
													)}
											/>
										{/snippet}
									</Field>
									{@render workspaceReadonlyMeta()}
								</Section>
								{#if workspace.organization}
									<Section name="branding" title={t('Branding')}>
										{@render logoControl(editing)}
									</Section>
								{/if}
							</Form>
						{/snippet}
					</RecordShell>
				</div>
			{:else}
				<div class="flex flex-col gap-4">
					{@render workspaceReadonlyMeta()}
					{#if workspace.organization}
						<form
							class="flex flex-col gap-4 border-t border-border pt-4"
							onsubmit={(e) => {
								e.preventDefault();
								if (logoDirty) fork(saveBrand());
							}}
						>
							{@render logoControl(true)}
							{#if logoDirty}{@render save()}{/if}
						</form>
					{/if}
				</div>
			{/if}
		{/snippet}
		{#snippet teamsTab()}<Teams {ctx} {bolt} {t} settings={s} reload={load} />{/snippet}
		{#snippet billingTab()}
			{#if workspace.billing !== undefined}
				{@const embedded = `${workspace.billing}${workspace.billing.includes('?') ? '&' : '?'}embed=1`}
				<div class="flex h-full min-h-0 flex-1 flex-col">
					<iframe
						src={embedded}
						title={t('Billing')}
						class="h-full min-h-0 w-full flex-1 border-0 bg-transparent"
					></iframe>
				</div>
			{/if}
		{/snippet}
		{#snippet assistantTab()}
			{#if assistant !== null}
				{@const a = assistant}
				{@const customPolicyCount = Object.values(a.policies).filter((v) => v.trim() !== '').length}
				<form
					class="flex h-full min-h-0 flex-1 flex-col gap-3"
					onsubmit={(e) => {
						e.preventDefault();
						fork(saveAssistant(a));
					}}
				>
					<Scroll name="assistant-settings" size="fill" layout="stack" gap="md">
						<div class="flex flex-wrap items-center justify-between gap-2">
							<p class="text-meta">
								{t(
									'Spending limits, default models and system agents. Changes apply to the next message.'
								)}
							</p>
							<Badge variant="outline" class="tabular-nums">
								<span class="text-muted-foreground">{t('Spent this month')}:</span>&nbsp;<span
									data-assistant-spent>{usd(spentNow)}</span
								>
							</Badge>
						</div>

						<div class="flex flex-col gap-4" data-assistant-settings>
							<section class="flex flex-col gap-3 rounded-lg border border-border p-4">
								<h3 class="text-sm font-medium">{t('Spending limits')}</h3>
								<div class="grid gap-3 sm:grid-cols-2">
									<label class="flex flex-col gap-1 text-sm">
										<span class="text-muted-foreground">{t('Monthly limit (USD)')}</span>
										<Input
											class="h-8"
											type="number"
											min="0"
											step="0.01"
											placeholder={t('No limit')}
											value={a.monthly}
											oninput={(e: Event & { currentTarget: HTMLInputElement }) =>
												(a.monthly = e.currentTarget.value)}
											data-assistant-monthly
										/>
									</label>
									<label class="flex flex-col gap-1 text-sm">
										<span class="text-muted-foreground">{t('Monthly limit per member (USD)')}</span>
										<Input
											class="h-8"
											type="number"
											min="0"
											step="0.01"
											placeholder={t('No limit')}
											value={a.member}
											oninput={(e: Event & { currentTarget: HTMLInputElement }) =>
												(a.member = e.currentTarget.value)}
											data-assistant-member
										/>
									</label>
								</div>
								{#if policyNames.length > 0}
									<details
										class="rounded-md border border-border/70 px-3 py-2 text-sm"
										open={customPolicyCount > 0}
										data-assistant-policies
									>
										<summary class="flex cursor-pointer items-center justify-between gap-2 font-medium">
											<span>{t('Per-policy member limits')}</span>
											{#if customPolicyCount > 0}
												<Badge variant="outline" class="tabular-nums">{customPolicyCount}</Badge>
											{/if}
										</summary>
										<p class="text-meta mt-1.5">
											{t(
												"A member gets the most generous of their policies' limits; a blank one uses the default above."
											)}
										</p>
										<div class="mt-2.5 grid gap-x-4 gap-y-2 sm:grid-cols-2">
											{#each policyNames as policy (policy)}
												<label class="flex items-center gap-2" data-assistant-policy={policy}>
													<span class="min-w-0 flex-1 truncate">{policy.replaceAll('_', ' ')}</span>
													<Input
														class="h-8 w-28"
														type="number"
														min="0"
														step="0.01"
														placeholder={t('Default')}
														value={a.policies[policy] ?? ''}
														oninput={(e: Event & { currentTarget: HTMLInputElement }) =>
															(a.policies[policy] = e.currentTarget.value)}
													/>
												</label>
											{/each}
										</div>
									</details>
								{/if}
							</section>

							<section class="flex flex-col gap-3 rounded-lg border border-border p-4">
								<h3 class="text-sm font-medium">{t('Models')}</h3>
								<div class="grid gap-3 sm:grid-cols-2">
									<label class="flex flex-col gap-1 text-sm" data-assistant-system1>
										<span class="text-muted-foreground"
											>{t('System 1: fast decisions (triage, AI filters)')}</span
										>
										<Combobox
											searchable
											clearable
											options={modelOptions(deciders.models)}
											value={a.system1}
											placeholder={`${t('Host default')}: ${labelOf(deciders.models, deciders.default)}`}
											aria-label={t('System 1 model')}
											on_change={(id) => (a.system1 = id)}
										/>
									</label>
									<label class="flex flex-col gap-1 text-sm" data-assistant-system2>
										<span class="text-muted-foreground">{t("System 2: Norbius's default model")}</span>
										<Combobox
											searchable
											clearable
											options={modelOptions(catalog)}
											value={a.system2}
											placeholder={t('Host default')}
											aria-label={t('System 2 model')}
											on_change={(id) => (a.system2 = id)}
										/>
									</label>
								</div>
								{#if catalog.length > 1}
									<details
										class="rounded-md border border-border/70 px-3 py-2 text-sm"
										open={a.models.length > 0}
										data-assistant-models
									>
										<summary class="flex cursor-pointer items-center justify-between gap-2 font-medium">
											<span>{t('Restrict models members may use')}</span>
											{#if a.models.length > 0}
												<Badge variant="outline" class="tabular-nums">{a.models.length}</Badge>
											{/if}
										</summary>
										<p class="text-meta mt-1.5">
											{t(
												'None chosen allows every model; with one, members see no model choice.'
											)}
										</p>
										<div class="mt-2.5 flex flex-col gap-2">
											{#if a.models.length > 0}
												<div class="flex flex-wrap gap-1.5">
													{#each a.models as id (id)}
														<span
															class="inline-flex items-center gap-1 rounded-full border py-0.5 pr-1 pl-2.5 text-xs"
															data-assistant-model={id}
															>{labelOf(catalog, id)}<button
																type="button"
																class="grid size-5 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
																aria-label={`${t('Remove')} ${id}`}
																onclick={() => (a.models = a.models.filter((x) => x !== id))}
																>×</button
															></span
														>
													{/each}
												</div>
											{/if}
											<Combobox
												searchable
												class="max-w-sm"
												options={modelOptions(catalog.filter((model) => !a.models.includes(model.id)))}
												value={null}
												placeholder={a.models.length === 0 ? t('Every model') : t('Add a model')}
												aria-label={t('Models members may use')}
												on_change={(id) => {
													if (id !== null) a.models = [...a.models, id];
												}}
											/>
										</div>
									</details>
								{/if}
							</section>

							<section
								class="flex flex-col gap-3 rounded-lg border border-border p-4 text-sm"
								aria-labelledby="assistant-system-heading"
								data-assistant-system
							>
								<div class="flex flex-col gap-0.5">
									<h3 id="assistant-system-heading" class="text-sm font-medium">{t('System agents')}</h3>
									<p class="text-meta">
										{t(
											"Agents that work with no person attending. They never merge, control a page or do anything that needs a person's confirmation."
										)}
									</p>
								</div>
								<label class="flex items-start gap-2">
									<Checkbox bind:checked={a.system.automations} />
									<span
										>{t('Let automations start agents')}<span class="block text-meta"
											>{t('An automation may hand work to an agent, under its own policies.')}</span
										></span
									>
								</label>
								{#if workspace.feedback === true}
									<label class="flex items-start gap-2">
										<Checkbox bind:checked={a.system.improve} />
										<span
											>{t('Improve automatically')}<span class="block text-meta"
												>{t(
													'An agent works on feedback and on automations that keep failing, and leaves its commits for an administrator to merge.'
												)}</span
											></span
										>
									</label>
									{#if a.system.improve}
										<label class="flex flex-col gap-1">
											<span class="text-muted-foreground"
												>{t('What automatic improvement may read')}</span
											>
											<Combobox
												multiple
												aria-label={t('What automatic improvement may read')}
												placeholder={t('No records: source only')}
												options={policyNames.map((policy) => ({ value: policy, label: policy }))}
												value={a.system.policies}
												on_change={(policies) => (a.system.policies = policies)}
											/>
										</label>
									{/if}
								{/if}
								{#if a.system.automations || (workspace.feedback === true && a.system.improve)}
									<div class="grid gap-3 pt-1 sm:grid-cols-2">
										{#each [['monthly', 'Monthly limit for system agents (USD)'], ['task', 'Limit for one piece of work (USD)']] as const as [key, label] (key)}
											<label class="flex flex-col gap-1">
												<span class="text-muted-foreground">{t(label)}</span>
												<Input
													class="h-8"
													type="number"
													min="0"
													step="0.01"
													placeholder={t('No limit')}
													value={a.system[key]}
													oninput={(e: Event & { currentTarget: HTMLInputElement }) =>
														(a.system[key] = e.currentTarget.value)}
												/>
											</label>
										{/each}
									</div>
								{/if}
							</section>
						</div>
					</Scroll>
					{@render save()}
				</form>
			{/if}
		{/snippet}
		{#snippet retentionTab()}
			<form
				class="flex h-full min-h-0 flex-1 flex-col gap-4"
				onsubmit={(e) => {
					e.preventDefault();
					const f = new FormData(e.currentTarget);
					fork(
						op('set_retention', {
							every_days: Number(f.get('every_days')),
							hour: Number(f.get('hour')),
							notifications_days: Number(f.get('notifications_days')),
							runs_days: Number(f.get('runs_days'))
						})
					);
				}}
			>
				<Scroll name="retention-settings" size="fill" layout="stack" gap="md">
					<p class="text-meta">
						{t('A built-in daily cleanup, run while the workspace is in use: it removes read notifications and finished runs past these ages. Unread notifications are kept.')}
					</p>
					<div class="grid gap-3 sm:grid-cols-2" data-retention-settings>
						{#each [['every_days', 'Run every (days)', 1, undefined], ['hour', 'From hour (workspace time)', 0, 23], ['notifications_days', 'Keep read notifications (days)', 1, undefined], ['runs_days', 'Keep finished runs (days)', 1, undefined]] as const as [name, label, min, max] (name)}
							<label class="flex flex-col gap-1 text-sm"
								><span class="text-muted-foreground">{t(label)}</span>
								<Input class="h-8" type="number" step="1" {name} {min} {max} value={s.retention[name]} /></label
							>
						{/each}
					</div>
				</Scroll>
				{@render save()}
			</form>
		{/snippet}
		<Tabs
			class="min-h-0 flex-1"
			tabs={[
				{ name: 'workspace', title: t('Workspace'), icon: 'concept:workspace', body: workspaceTab },
				...(workspace.billing !== undefined
					? [{ name: 'billing', title: t('Billing'), icon: 'lucide:receipt', body: billingTab }]
					: []),
				...(assistant !== null
					? [{ name: 'assistant', title: t('Assistant'), icon: 'concept:agents', body: assistantTab, keep_alive: true as const }]
					: []),
				{ name: 'retention', title: t('Data retention'), icon: 'lucide:history', body: retentionTab, keep_alive: true },
				{ name: 'teams', title: t('Teams'), icon: 'lucide:users', body: teamsTab }
			]}
		/>
	{:else if tab === 'integrations'}
		{#snippet connectionsTab()}
			<Integrations {ctx}
				connections
				{configuration}
				{api}
				{bolt}
				{t}
				settings={s}
				locale={chosenLocale(workspace.locale)}
				{integration_setups}
				reload={load}
			/>
		{/snippet}
		{#snippet envoysTab()}
			<Integrations {ctx}
				{configuration}
				{api}
				{bolt}
				{t}
				settings={s}
				locale={chosenLocale(workspace.locale)}
				{integration_setups}
				reload={load}
			/>
		{/snippet}
		{#snippet keysTab()}
			<Table {ctx}
				of={keys}
				key="keys"
				on_open={show('key')}
				toolbar={{
					title: t('API keys'),
					description: t('Keys for programmatic access. A new key is shown once.'),
					new: () => (creating = true)
				}}
				columns={[
					{ field: 'name', label: t('Name') },
					{ field: 'prefix', label: t('Key'), cell: mono },
					{ field: 'team', label: t('Team') },
					{ field: 'created_at', label: t('Created'), cell: at },
					{ field: 'last_used_at', label: t('Last used'), cell: at },
					{ field: 'revoked', label: t('revoked') },
					{ field: 'id', label: t('Actions'), hide: 'narrow', cell: keyCell }
				]}
			>
				{#snippet empty()}
					<EmptyState
						variant="inset"
						icon="link"
						title={t('No API keys yet.')}
						hint={t('Issue a key so a team can call this workspace.')}
					/>
				{/snippet}
			</Table>
		{/snippet}
		{#snippet mcpTab()}
			<Table {ctx}
				of={remotes}
				key="mcp-servers"
				on_open={show('remote')}
				toolbar={{
					title: t('MCP servers'),
					description: t('MCP servers this workspace connects to.'),
					new: false,
					export: false
				}}
				columns={[
					{ field: 'name', label: t('Name') },
					{ field: 'url', label: t('URL') }
				]}
			>
				{#snippet empty()}
					<EmptyState
						variant="inset"
						icon="links"
						title={t('No MCP servers')}
						hint={t('The workspace declares no MCP servers.')}
					/>
				{/snippet}
			</Table>
		{/snippet}
		<Tabs
			class="min-h-0 flex-1"
			value={integrationTab ?? (hasConnections ? 'connections' : 'envoys')}
			on_value_change={(value) => (integrationTab = value)}
			orientation="horizontal"
			tabs={[
				...(hasConnections
					? [
							{
								name: 'connections',
								title: t('Connections'),
								icon: 'concept:integrations',
								body: connectionsTab
							}
						]
					: []),
				{ name: 'envoys', title: t('Envoys'), icon: 'lucide:bot', body: envoysTab },
				{ name: 'keys', title: t('API keys'), icon: 'lucide:key-round', body: keysTab },
				{ name: 'mcp', title: t('MCP servers'), icon: 'lucide:server', body: mcpTab }
			]}
		/>
	{:else if tab === 'secrets'}
		<Table {ctx}
			of={secrets}
			key="secrets"
			on_open={(x) => {
				open = { kind: 'secret', id: x.id };
				secretValue = '';
			}}
			toolbar={{
				title: t('Secrets'),
				description: t('Values are write-only: open a secret to set it.')
			}}
			columns={[
				{ field: 'label', label: t('Name') },
				{ field: 'name', label: t('Variable'), cell: mono },
				{ field: 'status', label: t('Status') },
				{ field: 'id', label: t('Actions'), hide: 'narrow', cell: secretCell }
			]}
		>
			{#snippet empty()}
				<EmptyState
					variant="inset"
					icon="lock"
					title={t('No secrets')}
					hint={t('The workspace declares no secrets.')}
				/>
			{/snippet}
		</Table>
	{/if}
</SystemPage>

<!-- the open row's sheet -->
{#if open !== null && s !== null}
	{@const close = () => (open = null)}
	{#if open.kind === 'key'}
		{@const k = keys.find((x) => x.id === open?.id)}
		{#if k !== undefined}
			<DetailSheet {ctx} memory="setting"
				title={k.name}
				acts={keyActs(k)}
				on_close={close}
				fields={[
					{ label: t('Key'), value: k.prefix },
					{ label: t('Team'), value: k.team },
					{ label: t('Created'), value: when(k.created_at) },
					{ label: t('Last used'), value: when(k.last_used_at) },
					{ label: t('Status'), value: k.revoked ? t('revoked') : t('active') }
				]}
			/>
		{/if}
	{:else if open.kind === 'remote'}
		{@const r = remotes.find((x) => x.id === open?.id)}
		{#if r !== undefined}
			<DetailSheet {ctx} memory="setting"
				title={r.name}
				on_close={close}
				fields={[{ label: t('URL secret'), value: r.url }]}
				acts={r.secrets.map((name) => ({
					label: t('Set {name}').replace('{name}', name),
					run: () => {
						open = { kind: 'secret', id: name };
						secretValue = '';
					}
				}))}
			/>
		{/if}
	{:else if open.kind === 'secret'}
		{@const x = secrets.find((y) => y.id === open?.id)}
		{#if x !== undefined}
			<DetailSheet {ctx} memory="setting"
				title={x.label}
				acts={secretActs(x)}
				on_close={close}
				fields={[
					{ label: t('Variable'), value: x.name },
					{ label: t('Status'), value: x.status }
				]}
			>
				<form
					class="flex flex-wrap items-end gap-2"
					onsubmit={(e) => {
						e.preventDefault();
						fork(
							op('setSecret', { name: x.name, value: secretValue }).pipe(
								Effect.tap(() =>
									Effect.sync(() => {
										secretValue = '';
									})
								)
							)
						);
					}}
				>
					<label class="flex min-w-48 flex-1 flex-col gap-1 text-sm"
						><span class="text-meta">{t('New value')}</span>
						<Input
							class="h-8"
							type="password"
							autocomplete="off"
							required
							bind:value={secretValue}
						/></label
					>
					<Button type="submit" disabled={secretValue === ''}>{t('Set')}</Button>
				</form>
			</DetailSheet>
		{/if}
	{/if}
{/if}
<!-- The API key secret is shown once. -->
<Dialog.Root
	open={creating}
	on_open_change={(o) => {
		if (!o) closeDialog();
	}}
>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<Dialog.Title>{t('Issue key')}</Dialog.Title>
			{#if issued !== null}<Dialog.Description
					>{t('Copy this key now; it is not shown again:')}</Dialog.Description
				>{/if}
		</Dialog.Header>
		{#if issued !== null}
			<Input readonly value={issued} class="font-mono" aria-label={t('API key')} />
			<Dialog.Footer><Button onclick={closeDialog}>{t('Done')}</Button></Dialog.Footer>
		{:else if s !== null}
			<form
				class="flex flex-col gap-3"
				onsubmit={(e) => {
					e.preventDefault();
					create();
				}}
			>
				<Input
					class="h-8"
					placeholder={t('Key name')}
					aria-label={t('Key name')}
					required
					bind:value={form.keyName}
				/>
				<Combobox
					clearable
					placeholder={t('No team')}
					aria-label={t('Team')}
					options={teams}
					value={form.keyTeam || null}
					on_change={(v) => (form.keyTeam = v ?? '')}
				/>
				{#if error !== null}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
				<Dialog.Footer>
					<Button variant="outline" onclick={closeDialog}>{t('Cancel')}</Button>
					<Button type="submit" disabled={submitting}>{t('Issue key')}</Button>
				</Dialog.Footer>
			</form>
		{/if}
	</Dialog.Content>
</Dialog.Root>
