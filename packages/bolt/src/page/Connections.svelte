<!--
	@component Reusable plugin-style connection grid driven by Bolt's shared connection FSM.
	Supports `scope="personal"` (member-owned accounts, defaulting to `ctx.personal_connections`) and
	`scope="workspace"` (declared workspace accounts, `owner = null`).
	Handles querying `sys_integration`, `integration_offers()`, install/uninstall/resume, and inline `configuration`,
	conversation `listen` (listening scope), `classifier` (`ClassifierEditor`) editing and a conversation History tab
	(`ConnectionHistory`) inside each card's Manage Sheet.
-->
<script lang="ts">
	import { Effect, Schema } from 'effect';
	import type { Snippet } from 'svelte';
	import { observe_once } from '@norbital-ai/ui/effect';
	import { Alert, EmptyState, Field, Form, Spinner, Tabs, type UiContext } from '@norbital-ai/ui';
	import { Grid, Inline, Stack } from '@norbital-ai/ui/layout';
	import type { PersonalIntegrationName, WorkspaceIntegrationName } from '../decl/names.ts';
	import { classifierConfigOf, listeningScopeOf } from '../engine/integrations/scope.ts';
	import type { ShellBolt } from '../shell/runtime.ts';
	import IntegrationCard from './IntegrationCard.svelte';
	import ClassifierEditor from '../shell/integration/ClassifierEditor.svelte';
	import ConfigurationFields from '../shell/integration/ConfigurationFields.svelte';
	import ConnectionHistory from '../shell/integration/ConnectionHistory.svelte';
	import ListeningScopeEditor from '../shell/integration/ListeningScopeEditor.svelte';
	import { SHELL_ZH, humanise_word } from '../shell/i18n.ts';
	import { driverIcon, driverLabel } from '../shell/integration/setup.ts';

	type ConnectionsContext = UiContext &
		Pick<
			ShellBolt,
			| 'actor'
			| 'locale'
			| 'catalog'
			| 'integration'
			| 'integration_offers'
			| 'integration_setup'
			| 'personal_connections'
		>;

	type BaseProps = {
		/** The page's Bolt context: the viewer, their locale and the workspace's integrations. */
		ctx: ConnectionsContext;
		/** Optional display overrides (name, description, icon) keyed by integration definition name. */
		labels?:
			| Readonly<
					Record<
						string,
						{ readonly name?: string; readonly description?: string; readonly icon?: string }
					>
			  >
			| undefined;
		/** Optional extra settings rendered inside a connection's Manage Sheet (`close` closes the card Sheet before opening another). */
		manage?:
			| Snippet<[{ integration: string; instance: string; close: () => void }]>
			| undefined;
		/** Optional translator for framework/configuration strings; defaults to Bolt's built-in locale strings. */
		translate?: ((key: string) => string) | undefined;
		/** The title shown when there is no connection to offer. */
		empty_title?: string | undefined;
		/** The line under that title. */
		empty_hint?: string | undefined;
	};
	type Props =
		| (BaseProps & {
				/** `'personal'` (default): the viewer's own accounts. */
				scope?: 'personal' | undefined;
				/** Explicit personal definitions to offer; defaults to `ctx.personal_connections`. */
				integrations?: readonly PersonalIntegrationName[] | undefined;
		  })
		| (BaseProps & {
				/** `'workspace'`: shared workspace accounts (`owner = null`). */
				scope: 'workspace';
				/** Explicit workspace definitions to offer; defaults to declared workspace definitions and installed rows. */
				integrations?: readonly WorkspaceIntegrationName[] | undefined;
		  });

	let {
		ctx,
		scope = 'personal',
		integrations,
		labels,
		manage,
		translate,
		empty_title,
		empty_hint
	}: Props = $props();

	const t = $derived(
		(key: string) =>
			ctx.locale.toLowerCase().startsWith('zh') ? (SHELL_ZH[key] ?? key) : key
	);

	const me = $derived(ctx.actor?.kind === 'member' ? ctx.actor.id : null);
	const admin = $derived(ctx.actor?.kind === 'member' && ctx.actor.admin);
	const canRead = $derived(ctx.catalog?.['sys_integration'] !== undefined);
	const canCreate = $derived(ctx.catalog?.['sys_integration']?.create !== undefined);
	const canUpdate = $derived(ctx.catalog?.['sys_integration']?.update !== undefined);
	const canDelete = $derived(ctx.catalog?.['sys_integration']?.delete !== undefined);
	const canReadTeams = $derived(ctx.catalog?.['sys_team'] !== undefined);
	const canReadMembers = $derived(ctx.catalog?.['sys_user'] !== undefined);

	const offers = observe_once(() => ctx.integration_offers());
	const offerOf = (integration: string) =>
		offers.current?.find((item) => item.integration === integration);

	const accounts = $derived(
		!canRead || ctx.ui.bolt === undefined || (scope === 'personal' && me === null)
			? null
			: ctx.ui.bolt.query({
					sys_integration: {
						where:
							scope === 'personal' && me !== null
								? { owner: { eq: me } }
								: { owner: { is_null: true } },
						fields: ['name', 'integration', 'owner', 'active', 'status', 'listen', 'classifier', 'revision'],
						order_by: 'name',
						limit: 100
					}
				})
	);

	const directoryQuery = $derived(
		ctx.ui.bolt === undefined || (!canReadTeams && !canReadMembers)
			? null
			: ctx.ui.bolt.query({
					...(canReadTeams
						? { sys_team: { fields: ['name'], order_by: 'name', limit: 200 } }
						: {}),
					...(canReadMembers
						? {
								sys_user: {
									where: { active: { eq: true } },
									fields: ['name', 'email', 'phone'],
									order_by: 'name',
									limit: 500
								}
							}
						: {})
				})
	);

	const TeamRowSchema = Schema.Struct({ id: Schema.String, name: Schema.String });
	const MemberRowSchema = Schema.Struct({
		id: Schema.String,
		name: Schema.NullOr(Schema.String),
		email: Schema.NullOr(Schema.String),
		phone: Schema.NullOr(Schema.String)
	});
	const isTeamRow = Schema.is(TeamRowSchema);
	const isMemberRow = Schema.is(MemberRowSchema);

	const teamOptions = $derived(
		(directoryQuery?.current?.['sys_team']?.rows ?? []).filter(isTeamRow)
	);
	const memberOptions = $derived(
		(directoryQuery?.current?.['sys_user']?.rows ?? []).filter(isMemberRow)
	);

	const AccountRowSchema = Schema.Struct({
		id: Schema.String,
		name: Schema.String,
		integration: Schema.String,
		owner: Schema.NullOr(Schema.String),
		active: Schema.Boolean,
		status: Schema.NullOr(Schema.Json),
		listen: Schema.NullOr(Schema.Json),
		classifier: Schema.NullOr(Schema.Json),
		revision: Schema.Number
	});
	type AccountRow = typeof AccountRowSchema.Type;
	type AccountTarget = { readonly id: string; readonly revision: number };
	const isAccountRow = Schema.is(AccountRowSchema);

	const rows = $derived<readonly AccountRow[]>(
		(accounts?.current?.['sys_integration']?.rows ?? []).filter(isAccountRow)
	);

	const listedPersonal = $derived<readonly string[]>(
		integrations !== undefined
			? [...integrations]
			: ctx.personal_connections.length > 0
				? ctx.personal_connections
				: [...new Set(rows.map((row) => row.integration))]
	);

	const listedWorkspace = $derived<readonly string[]>(
		integrations !== undefined
			? [...integrations]
			: [
					...new Set([
						...rows.map((row) => row.integration),
						...(offers.current ?? [])
							.filter((offer) => offer.declared === true)
							.map((offer) => offer.integration)
					])
				]
	);

	const displayNameOf = (integration: string, fallback?: string): string => {
		const override = labels?.[integration]?.name;
		if (override !== undefined && override !== '') return override;
		if (fallback !== undefined && fallback !== '') return fallback;
		const offer = offerOf(integration);
		if (offer !== undefined && offer.custom !== true) return driverLabel(offer.driver);
		return humanise_word(integration);
	};

	const displayIconOf = (integration: string): string => {
		const override = labels?.[integration]?.icon;
		if (override !== undefined && override !== '') return override;
		const offer = offerOf(integration);
		const pool = scope === 'personal' ? offer?.personal : offer?.workspace;
		return pool?.[0]?.icon ?? driverIcon(offer?.driver ?? integration);
	};

	const displayDescOf = (integration: string): string => {
		const override = labels?.[integration]?.description;
		if (override !== undefined && override !== '') return override;
		return offerOf(integration)?.description ?? '';
	};

	const setupEntryOf = (integration: string) => {
		const load = ctx.integration_setup(integration);
		return load === undefined ? undefined : { load };
	};

	const install = (integration: string, owner: string | null) => {
		const bolt = ctx.ui.bolt;
		if (bolt === undefined)
			return Effect.fail({ message: t('This connection could not be made.') });
		return bolt
			.act({
				'sys_integration.create': [
					{
						integration,
						name: displayNameOf(integration),
						owner
					}
				]
			})
			.pipe(
				Effect.flatMap((outcome) => {
					const created =
						'records' in outcome
							? outcome.records.find((row) => row.model === 'sys_integration')
							: undefined;
					return created === undefined
						? Effect.fail({ message: t('This connection could not be made.') })
						: Effect.succeed(created.id);
				}),
				Effect.mapError((cause) => ({ message: cause.message }))
			);
	};

	const uninstall = (row: AccountTarget) => {
		const bolt = ctx.ui.bolt;
		if (bolt === undefined) return Effect.fail({ message: t('The request failed.') });
		return bolt
			.act({
				'sys_integration.delete': [{ target: { id: row.id, revision: row.revision } }]
			})
			.pipe(
				Effect.asVoid,
				Effect.mapError((cause) => ({ message: cause.message }))
			);
	};

	const resume = (row: AccountTarget) => {
		const bolt = ctx.ui.bolt;
		if (bolt === undefined)
			return Effect.fail({ message: t('This connection could not be made.') });
		return bolt
			.act({
				'sys_integration.update': [
					{ target: { id: row.id, revision: row.revision }, set: { active: true } }
				]
			})
			.pipe(
				Effect.asVoid,
				Effect.mapError((cause) => ({ message: cause.message }))
			);
	};
</script>

{#snippet configAndManage(account: AccountRow, close: () => void)}
	{@const offer = offerOf(account.integration)}
	{@const configFields = offer?.configuration ?? {}}
	{@const canEdit = canUpdate && (scope === 'personal' || admin)}
	{@const hasConfig = Object.keys(configFields).length > 0 && canEdit}
	{@const isConversation = offer?.conversation === true}
	{@const hasListen = isConversation && canEdit}
	{#snippet settingsPane()}
		<Stack gap="md">
			{#if hasConfig || hasListen}
				<Form {ctx} of="sys_integration" mode="update" id={account.id} size="content" submit={t('Save')}>
					{#if hasConfig}
						<Field {ctx} name="configuration" label={t('Configuration')}>
							{#snippet editor(field)}
								<ConfigurationFields
									{ctx}
									integration={account.integration}
									fields={configFields}
									{field}
									{t}
									translate={translate ?? t}
								/>
							{/snippet}
						</Field>
					{/if}
					{#if hasListen}
						<Field {ctx} name="listen" label={t('Listening scope')}>
							{#snippet editor(field)}
								<ListeningScopeEditor
									driver={offer?.driver ?? account.integration}
									instance={account.id}
									client={ctx.integration(account.id)}
									value={listeningScopeOf(field.value)}
									on_change={(next) => field.on_change(next)}
									teams={teamOptions}
									members={memberOptions}
									disabled={field.disabled}
									{t}
								/>
							{/snippet}
						</Field>
						<Field {ctx} name="classifier" label={t('Classifier')}>
							{#snippet editor(field)}
								<ClassifierEditor
									value={classifierConfigOf(field.value)}
									on_change={(next) => field.on_change(next)}
									automations={offer?.automations ?? []}
									disabled={field.disabled}
									{t}
								/>
							{/snippet}
						</Field>
					{/if}
				</Form>
			{/if}
			{#if manage !== undefined}
				<div class={hasConfig || hasListen ? 'border-t border-border pt-4' : undefined}>
					{@render manage({ integration: account.integration, instance: account.id, close })}
				</div>
			{/if}
		</Stack>
	{/snippet}
	{#if isConversation}
		{#snippet historyPane()}
			{@const client = ctx.integration(account.id)}
			<ConnectionHistory
				{ctx}
				driver={offer?.driver ?? account.integration}
				instance={account.id}
				load={(before) => client.messages(before)}
				locale={ctx.locale}
				{t}
			/>
		{/snippet}
		<Tabs
			orientation="horizontal"
			tabs={[
				{
					name: 'settings',
					title: t('Settings'),
					icon: 'lucide:settings-2',
					body: settingsPane,
					keep_alive: true
				},
				{
					name: 'history',
					title: t('History'),
					icon: 'lucide:messages-square',
					body: historyPane,
					keep_alive: true
				}
			]}
		/>
	{:else}
		{@render settingsPane()}
	{/if}
{/snippet}

<Stack gap="md" data-connections={scope}>
	{#if accounts?.loading && accounts.current === undefined}
		<Inline gap="sm" align="center" aria-busy="true">
			<Spinner />
			<span class="text-sm text-muted-foreground">{t('Loading…')}</span>
		</Inline>
	{:else if accounts?.error}
		<Alert.Root variant="destructive">
			<Alert.Title>{accounts.error.message}</Alert.Title>
		</Alert.Root>
	{:else if offers.error !== undefined}
		<Alert.Root variant="destructive">
			<Alert.Title>{offers.error.message}</Alert.Title>
		</Alert.Root>
	{/if}

	{#if scope === 'personal'}
		{#if listedPersonal.length === 0}
			<EmptyState
				variant="inset"
				icon="link"
				title={empty_title ?? t('My connections')}
				hint={empty_hint ?? t('No personal connections are configured for your role.')}
			/>
		{:else}
			<Grid minimum="card" gap="md">
				{#each listedPersonal as kind (kind)}
					{@const account = rows.find((row) => row.integration === kind) ?? null}
					{@const offer = offerOf(kind)}
					{@const hasConfig = Object.keys(offer?.configuration ?? {}).length > 0 && canUpdate}
					{@const hasListen = offer?.conversation === true && canUpdate}
					{#snippet personalManage({ close }: { close: () => void })}
						{#if account !== null}
							{@render configAndManage(account, close)}
						{/if}
					{/snippet}
					<IntegrationCard
						driver={offer?.driver ?? kind}
						name={displayNameOf(kind, account?.name)}
						icon={displayIconOf(kind)}
						description={displayDescOf(kind)}
						providers={offer?.personal ?? []}
						providers_ready={!offers.loading}
						instance={account === null
							? null
							: { id: account.id, status: account.status, active: account.active }}
						client={(id) => ctx.integration(id)}
						setup={setupEntryOf(kind)}
						create={me !== null && canCreate ? () => install(kind, me) : undefined}
						on_delete={account !== null && canDelete ? () => uninstall(account) : undefined}
						on_resume={account !== null && canUpdate ? () => resume(account) : undefined}
						manage={account !== null && (hasConfig || hasListen || manage !== undefined)
							? personalManage
							: undefined}
						readonly={me === null || (!canCreate && !canUpdate)}
						locale={ctx.locale}
						{t}
					/>
				{/each}
			</Grid>
		{/if}
	{:else if listedWorkspace.length === 0 && rows.length === 0}
		<EmptyState
			variant="inset"
			icon="link"
			title={empty_title ?? t('Connections')}
			hint={empty_hint ?? t('Choose an integration, name the account, then pair its provider.')}
		/>
	{:else}
		<Grid minimum="card" gap="md">
			{#each listedWorkspace as kind (kind)}
				{@const existing = rows.filter((row) => row.integration === kind)}
				{@const offer = offerOf(kind)}
				{@const hasConfig = Object.keys(offer?.configuration ?? {}).length > 0 && admin && canUpdate}
				{@const hasListen = offer?.conversation === true && admin && canUpdate}
				{#if existing.length > 0}
					{#each existing as account (account.id)}
						{#snippet workspaceManage({ close }: { close: () => void })}
							{@render configAndManage(account, close)}
						{/snippet}
						<IntegrationCard
							driver={offer?.driver ?? kind}
							name={account.name}
							icon={displayIconOf(kind)}
							description={displayDescOf(kind)}
							providers={offer?.workspace ?? []}
							providers_ready={!offers.loading}
							instance={{ id: account.id, status: account.status, active: account.active }}
							client={(id) => ctx.integration(id)}
							setup={setupEntryOf(kind)}
							on_delete={admin && canDelete ? () => uninstall(account) : undefined}
							on_resume={admin && canUpdate ? () => resume(account) : undefined}
							manage={hasConfig || hasListen || manage !== undefined ? workspaceManage : undefined}
							readonly={!admin}
							locale={ctx.locale}
							{t}
						/>
					{/each}
				{:else if admin && canCreate}
					<IntegrationCard
						driver={offer?.driver ?? kind}
						name={displayNameOf(kind)}
						icon={displayIconOf(kind)}
						description={displayDescOf(kind)}
						providers={offer?.workspace ?? []}
						providers_ready={!offers.loading}
						instance={null}
						client={(id) => ctx.integration(id)}
						setup={setupEntryOf(kind)}
						create={() => install(kind, null)}
						locale={ctx.locale}
						{t}
					/>
				{/if}
			{/each}
		</Grid>
	{/if}
</Stack>
