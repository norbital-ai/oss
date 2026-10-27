<!-- Administrators manage members and invitations; teams, policies and approval routes belong to source. -->
<script lang="ts">
	import { observe, fork } from '@norbital-ai/ui/effect';
	import { Effect, Option, Queue, Schema, Stream } from 'effect';
	import type { Value } from '@norbital-ai/std/kind';
	import { Cluster } from '@norbital-ai/ui/layout';
	import type { Snippet } from 'svelte';
	import { watch } from 'runed';
	import {
		Button,
		Checkbox,
		Combobox,
		confirmAction,
		Dialog,
		EmptyState,
		format,
		Input,
		PhoneInput,
		Table,
		Tabs,
		Textarea
	} from '@norbital-ai/ui';
	import type { Json } from '../../decl/values.ts';
	import type { AiModel } from '../../engine/contracts.ts';
	import { based, type SettingsTab, type ShellBoot } from '../nav.ts';
	import type { ShellBolt } from '../runtime.ts';
	import type { ShellApi } from '../api-types.ts';
	import type { Act } from '../Acts.svelte';
	import Acts from '../Acts.svelte';
	import { chosenLocale } from '../i18n.ts';
	import type { IntegrationSetupEntry } from '../integration/setup.ts';
	import DetailSheet from '../DetailSheet.svelte';
	import Integrations from '../integration/Integrations.svelte';
	import Runs from '../runs/Runs.svelte';
	import SystemPage from '../SystemPage.svelte';
	import peopleBanner from '../assets/banners/people.jpg';
	import organizationBanner from '../assets/banners/organization.jpg';
	import auditBanner from '../assets/banners/audit.jpg';
	import automationsBanner from '../assets/banners/automations.jpg';
	import integrationsBanner from '../assets/banners/integrations.jpg';
	import secretsBanner from '../assets/banners/secrets.jpg';

	let {
		api,
		bolt,
		t,
		tab,
		workspace,
		startable,
		integrationSetups,
		run = null,
		onRun
	}: {
		api: ShellApi;
		bolt: ShellBolt;
		t: (key: string) => string;
		tab: SettingsTab;
		workspace: ShellBoot['workspace'];
		startable: NonNullable<ShellBoot['startable']>;
		/** The definitions' own setup components (`integration/<name>/+integration.svelte`); the generic setup otherwise. */
		integrationSetups?: { readonly [integration: string]: IntegrationSetupEntry } | undefined;
		run?: string | null;
		onRun: (id: string | null) => void;
	} = $props();

	const TITLES: { readonly [k in SettingsTab]: string } = {
		people: 'People',
		organization: 'Organization',
		audit: 'Audit',
		automations: 'Automations',
		integrations: 'Integrations',
		secrets: 'Secrets'
	};
	const ICONS: { readonly [k in SettingsTab]: string } = {
		people: 'lucide:users',
		organization: 'lucide:building-2',
		audit: 'lucide:scroll-text',
		automations: 'lucide:play',
		integrations: 'lucide:plug',
		secrets: 'lucide:key-round'
	};
	const DESCRIPTIONS: { readonly [k in SettingsTab]: string } = {
		people: 'Members, invitations and who can do what.',
		organization: 'Workspace identity, branding and assistant limits.',
		audit: 'Every write, refusal and sign-in, newest first.',
		automations: 'Queued and completed background runs.',
		integrations: 'Envoys, API keys and MCP servers for this workspace.',
		secrets: 'Write-only values the workspace source reads by name.'
	};
	const BANNERS: { readonly [k in SettingsTab]: string } = {
		people: peopleBanner,
		organization: organizationBanner,
		audit: auditBanner,
		automations: automationsBanner,
		integrations: integrationsBanner,
		secrets: secretsBanner
	};
	let invalidate: (() => void) | undefined;
	const settings = observe(() => {
		const owner = api,
			source = bolt;
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
					source.query({ sys_integration: { fields: ['revision'] } })
				)
				.pipe(Stream.map(() => undefined))
		).pipe(Stream.switchMap(() => Stream.fromEffect(owner.settings())));
	});
	const s = $derived(settings.current ?? null);
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
			const result = yield* Effect.result(api.settingsOp(name, body));
			if (result._tag === 'Failure') {
				mutationError = result.failure.message;
				if (name === 'invite' || name === 'resendInvitation') yield* load();
				return undefined;
			}
			yield* load();
			return result.success;
		});
	/** Rule 39: a member id, or `{ team }`. */
	const preview = Effect.fn('Settings.preview')(function* (target: string | { team: string }) {
		const r = yield* Effect.result(api.preview(target));
		if (r._tag === 'Success') location.assign(based('/'));
		else mutationError = r.failure.message;
	});
	// `access.explain` (L-BOLT-234): what a member or team holds, in a sheet
	let explained = $state<{ who: string; value: Json } | null>(null);
	const explain = Effect.fn('Settings.explain')(function* (
		who: string,
		target: { user: string } | { team: string }
	) {
		const r = yield* Effect.result(api.explain(target));
		if (r._tag === 'Success') explained = { who, value: r.success };
		else mutationError = r.failure.message;
	});

	const str = (v: Json | undefined) => (v === null || v === undefined ? '' : String(v));
	const when = (v: Json | undefined) =>
		typeof v === 'string' && v !== ''
			? format({ kind: 'instant' }, v, { locale: bolt.locale })
			: '—';
	const named = (rows: readonly { readonly id: string; readonly name: string }[]) =>
		rows.map((r) => ({ value: r.id, label: r.name }));

	// ── rows: the settings read projected per table  ──
	const teamName = (id: string | null) => s?.teams.find((x) => x.id === id)?.name ?? '';
	const members = $derived(
		(s?.members ?? []).map((u) => ({
			id: u.id,
			name: u.name ?? '',
			email: u.email ?? '',
			phone: u.phone ?? '',
			telegram: u.telegram ?? '',
			kind: u.kind === 'external' ? t('External') : t('Staff'),
			external: u.kind === 'external',
			team: teamName(u.team),
			team_id: u.team || null,
			admin: u.admin,
			active: u.active,
			last_seen: u.last_seen || null
		}))
	);
	const invitations = $derived(
		(s?.invitations ?? []).map((i) => ({
			id: i.id,
			email: i.email || i.phone || '',
			team: teamName(i.team),
			external: i.external,
			status: t(i.status),
			state: i.status,
			expires_at: i.expires_at
		}))
	);
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
		(s?.mcp ?? []).map((remote) => ({ id: remote.name, name: remote.name, url: str(remote.url) }))
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
	type Member = (typeof members)[number];
	type Invitation = (typeof invitations)[number];
	type Key = (typeof keys)[number];
	type Secret = (typeof secrets)[number];
	const memberActs = (u: Pick<Member, 'id' | 'active' | 'admin' | 'name' | 'email'>): Act[] =>
		u.active && !u.admin
			? [
					{ label: t('Preview as'), run: () => fork(preview(u.id)), variant: 'outline' },
					{ label: t('Explain'), run: () => fork(explain(u.name || u.email, { user: u.id })) }
				]
			: [];
	const invitationActs = (i: Invitation): Act[] => [
		...(i.state === 'open' || i.state === 'expired'
			? [{ label: t('Resend'), run: () => fork(op('resendInvitation', { id: i.id })) }]
			: []),
		...(i.state === 'open'
			? [{ label: t('Revoke'), run: () => fork(op('revokeInvitation', { id: i.id })) }]
			: [])
	];
	const keyActs = (k: Key): Act[] =>
		k.revoked
			? []
			: [
					{ label: t('Rotate'), run: () => fork(rotate(k.id)) },
					{
						label: t('Revoke'),
						run: () =>
							fork(
								confirmAction({
									title: t('Revoke the key {name}? Programs using it stop at once.').replace(
										'{name}',
										k.name
									),
									confirmLabel: t('Revoke'),
									cancelLabel: t('Cancel'),
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
	type Open = { kind: 'member' | 'invitation' | 'key' | 'remote' | 'secret'; id: string };
	let open = $state<Open | null>(null);
	const show = (kind: Open['kind']) => (row: { id: string }) => {
		open = { kind, id: row.id };
		handles = {};
	};
	/** The open member's unsaved handles (rule 57: what a private envoy knows them by); a key left out is unchanged. */
	let handles = $state<{ phone?: string | null; telegram?: string }>({});
	const saveHandles = Effect.fn('Settings.saveHandles')(function* (id: string) {
		if ((yield* op('setHandles', { id, ...handles })) !== undefined) handles = {};
	});
	let peopleTab = $state('members');
	type Creating = 'invite' | 'key';
	let bulkAddresses = $state('');
	let submitting = $state(false);
	let creating = $state<Creating | null>(null);
	let form = $state({
		email: '',
		phone: null as string | null,
		team: '',
		external: false,
		keyName: '',
		keyTeam: ''
	});
	/** A new or rotated key, shown once in the dialog. */
	let issued = $state<string | null>(null);
	const Issued = Schema.Struct({ key: Schema.String });
	/** `inviteMany` answers the invitations whose delivery failed (`invite` refuses instead). */
	const Invited = Schema.Struct({ failed: Schema.Array(Schema.String) });
	/** `issueKey` and `rotateKey` answer the new key, shown once. */
	const keyOf = (v: Json | undefined) =>
		Option.getOrNull(Option.map(Schema.decodeUnknownOption(Issued)(v), (answer) => answer.key));
	function create(): void {
		if (submitting) return;
		submitting = true;
		fork(
			Effect.gen(function* () {
				const c = creating;
				const invitations = bulkAddresses
					.split(/[\n,;]+/)
					.map((address) => address.trim())
					.filter(Boolean)
					.map((address) => ({
						...(address.startsWith('+') ? { phone: address } : { email: address }),
						...(form.team ? { team: form.team } : {}),
						external: form.external
					}));
				const command =
					c !== 'invite'
						? op('issueKey', { name: form.keyName, team: form.keyTeam || null })
						: bulkAddresses.trim() !== ''
							? op('inviteMany', { invitations })
							: op('invite', {
									email: form.email || undefined,
									phone: form.phone ?? undefined,
									team: form.team || undefined,
									external: form.external
								});
				const v = yield* command;
				if (v === undefined) return; // refused: the dialog stays with the page's error
				if (c === 'key') issued = keyOf(v);
				else {
					creating = null;
					bulkAddresses = '';
					if (Option.exists(Schema.decodeUnknownOption(Invited)(v), (i) => i.failed.length > 0))
						mutationError = t(
							'Invitations were saved, but some could not be delivered. Resend them from Invitations.'
						);
				}
			}).pipe(
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
			creating = 'key';
		}
	});
	function closeDialog(): void {
		creating = null;
		bulkAddresses = '';
		issued = null;
		form = { ...form, email: '', phone: null, keyName: '', keyTeam: '' };
	}
	const CREATE_TITLES: { readonly [k in Creating]: string } = {
		invite: 'Invite',
		key: 'Issue key'
	};

	// L-COL-199: the workspace's name and logo, when the host lets an administrator edit them; a saved change reloads the shell's branding
	// svelte-ignore state_referenced_locally
	let brand = $state({ name: workspace.name, logo: workspace.logo ?? (null as string | null) });
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
		const r = yield* Effect.result(api.organization(brand.name.trim(), brand.logo));
		if (r._tag === 'Success') location.reload();
		else mutationError = r.failure.message;
	});
	let secretValue = $state('');
	// the assistant's runtime settings (Organization): read with the model catalogue, saved as one settings verb
	let assistant = $state<{
			monthly: string;
			member: string;
			policies: { [policy: string]: string };
			models: string[];
		} | null>(null),
		catalog = $state<readonly AiModel[]>([]),
		policyNames = $state<readonly string[]>([]),
		spentNow = $state(0);
	const loadAssistant = Effect.fn('Settings.assistant')(function* () {
		const r = yield* Effect.result(api.agent.models());
		const admin = r._tag === 'Success' ? r.success.admin : undefined;
		if (admin === undefined) return;
		catalog = admin.catalog;
		spentNow = admin.spent;
		policyNames = admin.policies;
		assistant = {
			monthly: admin.settings.monthly?.toString() ?? '',
			member: admin.settings.member?.toString() ?? '',
			policies: Object.fromEntries(
				admin.policies.map((p) => [p, admin.settings.policies[p]?.toString() ?? ''])
			),
			models: [...admin.settings.models]
		};
	});
	watch(
		() => tab,
		(current) => {
			if (current === 'organization') fork(loadAssistant());
		}
	);
	const limit = (v: string) => (v.trim() === '' ? null : Math.max(0, Number(v)));
	const usd = (n: number) =>
		new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(n);
</script>

{#snippet card(title: string, description: string, body: Snippet)}
	<section class="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4">
		<div class="flex flex-col gap-0.5">
			<h2 class="text-sm font-medium">{title}</h2>
			<p class="text-meta">{description}</p>
		</div>
		{@render body()}
	</section>
{/snippet}
{#snippet at({ value }: { row: object; value: unknown })}<time class="tabular-nums"
		>{when(typeof value === 'string' ? value : null)}</time
	>{/snippet}
{#snippet lastSeen({ row }: { row: { readonly id: string }; value: Value | undefined })}<time
		class="tabular-nums"
		>{when(members.find((member) => member.id === row.id)?.last_seen ?? null)}</time
	>{/snippet}
{#snippet memberCell({
	row
}: {
	row: { readonly id: string; readonly [field: string]: Value };
	value: Value | undefined;
})}<Acts
		acts={memberActs({
			id: String(row.id),
			name: String(row.name ?? ''),
			email: String(row.email ?? ''),
			active: row.active === true,
			admin: row.admin === true
		})}
	/>{/snippet}
{#snippet invitationCell({ row }: { row: Invitation; value: unknown })}<Acts
		acts={invitationActs(row)}
	/>{/snippet}
{#snippet keyCell({ row }: { row: Key; value: unknown })}<Acts acts={keyActs(row)} />{/snippet}
{#snippet secretCell({ row }: { row: Secret; value: unknown })}<Acts
		acts={secretActs(row)}
	/>{/snippet}
{#snippet mono({ value }: { row: object; value: unknown })}<code class="font-mono text-xs"
		>{String(value ?? '')}</code
	>{/snippet}

{#snippet membersTab()}
	{#key s}
		<Table
			of="sys_user"
			key="members"
			onOpen={(row) => {
				if (typeof row.id === 'string') open = { kind: 'member', id: row.id };
			}}
			toolbar={{
				title: t('Members'),
				description: t(
					'Everyone with access to this workspace. Administrators see everything; preview a member to check what their teams grant.'
				),
				new: () => (creating = 'invite'),
				export: true
			}}
			columns={[
				{ field: 'name', label: t('Name') },
				{ field: 'email', label: t('Email') },
				{ field: 'phone', label: t('Mobile number') },
				{ field: 'team', label: t('Team') },
				{ field: 'kind', label: t('Kind') },
				{ field: 'admin', label: t('Admin') },
				{ field: 'active', label: t('Active') },
				{ field: 'created_at', label: t('Last seen'), cell: lastSeen },
				{ field: 'id', label: t('Actions'), hide: 'narrow', cell: memberCell }
			]}
		/>
	{/key}
{/snippet}
{#snippet invitationsTab()}
	{#if s?.signup}
		<Cluster gap="sm" justify="between">
			<p class="text-meta">
				{t(
					'This workspace lets people join by proving their address. Close sign-up to admit only invited members.'
				)}
			</p>
			<label class="flex items-center gap-2 text-sm"
				><Checkbox
					checked={s.signup.open}
					onCheckedChange={(v) => fork(op('setSignup', { open: v === true }))}
				/>
				{t('Newcomers may sign up')}</label
			>
		</Cluster>
	{/if}
	<Table
		of={invitations}
		key="invitations"
		onOpen={show('invitation')}
		toolbar={{
			title: t('Invitations'),
			description: t(
				'Invite people by email or mobile number. External members can never be administrators.'
			),
			new: () => (creating = 'invite'),
			export: true
		}}
		columns={[
			{ field: 'email', label: t('Address') },
			{ field: 'team', label: t('Team') },
			{ field: 'status', label: t('Status') },
			{ field: 'external', label: t('External') },
			{ field: 'expires_at', label: t('Expires'), cell: at },
			{ field: 'id', label: t('Actions'), hide: 'narrow', cell: invitationCell }
		]}
	/>
{/snippet}

{#if tab === 'automations'}
	<Runs {api} {bolt} {t} {startable} {run} {onRun} />
{:else}
	<SystemPage
		name={`settings-${tab}`}
		title={t(TITLES[tab])}
		icon={ICONS[tab]}
		banner={BANNERS[tab]}
		description={t(DESCRIPTIONS[tab])}
		{error}
	>
		{#if s === null}
			<p class="text-sm text-muted-foreground">{t('Loading…')}</p>
		{:else if tab === 'people'}
			<Tabs
				level={2}
				orientation="horizontal"
				bind:value={peopleTab}
				tabs={[
					{ name: 'members', title: t('Members'), icon: 'lucide:users', body: membersTab },
					{
						name: 'invitations',
						title: t('Invitations'),
						icon: 'lucide:mail-plus',
						body: invitationsTab
					}
				]}
			/>
		{:else if tab === 'organization'}
			{#snippet workspaceInfo()}
				<dl class="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm">
					<dt class="text-muted-foreground">{t('Workspace')}</dt>
					<dd>{workspace.name}</dd>
					<dt class="text-muted-foreground">{t('Locale')}</dt>
					<dd>{workspace.locale}</dd>
					<dt class="text-muted-foreground">{t('Time zone')}</dt>
					<dd>{workspace.tz}</dd>
				</dl>
			{/snippet}
			{@render card(t('Workspace'), t('Set by the workspace source.'), workspaceInfo)}
			{#if workspace.organization}
				{#snippet branding()}
					<form
						class="flex flex-col gap-3"
						onsubmit={(e) => {
							e.preventDefault();
							fork(saveBrand());
						}}
					>
						<label class="flex flex-col gap-1 text-sm"
							><span class="text-muted-foreground">{t('Workspace name')}</span>
							<Input class="h-8" required maxlength={80} bind:value={brand.name} /></label
						>
						<div class="flex flex-wrap items-center gap-3 text-sm">
							<span class="text-muted-foreground">{t('Logo')}</span>
							{#if brand.logo !== null}<img
									src={brand.logo}
									alt={t('Logo')}
									class="size-10 rounded-sm border object-contain"
								/>{/if}
							<input
								type="file"
								accept="image/png,image/svg+xml,image/webp,image/jpeg"
								aria-label={t('Logo')}
								class="text-xs"
								onchange={(e) => pickLogo(e.currentTarget.files?.[0])}
							/>
							{#if brand.logo !== null}<Button
									size="sm"
									variant="ghost"
									onclick={() => (brand.logo = null)}>{t('Remove logo')}</Button
								>{/if}
						</div>
						<Cluster gap="sm"
							><Button type="submit" disabled={brand.name.trim() === ''}>{t('Save')}</Button
							></Cluster
						>
					</form>
				{/snippet}
				{@render card(t('Branding'), t('The name and logo every member sees.'), branding)}
			{/if}
			{#if assistant !== null}
				{@const a = assistant}
				{#snippet assistantForm()}
					<form
						class="flex flex-col gap-3"
						data-assistant-settings
						onsubmit={(e) => {
							e.preventDefault();
							fork(
								op('setAgent', {
									monthly: limit(a.monthly),
									member: limit(a.member),
									policies: Object.fromEntries(
										Object.entries(a.policies).flatMap(([p, v]) => {
											const cap = limit(v);
											return cap === null ? [] : [[p, cap]];
										})
									),
									models: a.models
								}).pipe(Effect.andThen(loadAssistant()))
							);
						}}
					>
						<p class="text-sm">
							<span class="text-muted-foreground">{t('Spent this month')}:</span>
							<span class="tabular-nums" data-assistant-spent>{usd(spentNow)}</span>
						</p>
						<div class="grid gap-3 sm:grid-cols-2">
							<label class="flex flex-col gap-1 text-sm"
								><span class="text-muted-foreground">{t('Monthly limit (USD)')}</span>
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
								/></label
							>
							<label class="flex flex-col gap-1 text-sm"
								><span class="text-muted-foreground">{t('Monthly limit per member (USD)')}</span>
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
								/></label
							>
						</div>
						{#if policyNames.length > 0}
							<fieldset class="flex flex-col gap-1.5 text-sm" data-assistant-policies>
								<legend class="mb-1 text-muted-foreground">
									{t(
										"Monthly limit per member by policy (USD). A member gets the most generous of their policies' limits; a blank one uses the default above."
									)}
								</legend>
								<div class="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
									{#each policyNames as policy (policy)}
										<label class="flex items-center gap-2" data-assistant-policy={policy}
											><span class="min-w-0 flex-1 truncate">{policy.replaceAll('_', ' ')}</span>
											<Input
												class="h-8 w-32"
												type="number"
												min="0"
												step="0.01"
												placeholder={t('Default')}
												value={a.policies[policy] ?? ''}
												oninput={(e: Event & { currentTarget: HTMLInputElement }) =>
													(a.policies[policy] = e.currentTarget.value)}
											/></label
										>
									{/each}
								</div>
							</fieldset>
						{/if}
						{#if catalog.length > 1}
							<fieldset class="flex flex-col gap-1.5 text-sm" data-assistant-models>
								<legend class="mb-1 text-muted-foreground">
									{t(
										'Models members may use. None chosen allows every model; with one, members see no model choice.'
									)}
								</legend>
								{#if a.models.length > 0}
									<div class="flex flex-wrap gap-1.5">
										{#each a.models as id (id)}
											<span
												class="inline-flex items-center gap-1 rounded-full border py-0.5 pr-1 pl-2.5 text-xs"
												data-assistant-model={id}
												>{catalog.find((model) => model.id === id)?.label ?? id}<button
													type="button"
													class="grid size-5 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
													aria-label={`${t('Remove')} ${id}`}
													onclick={() => (a.models = a.models.filter((x) => x !== id))}>×</button
												></span
											>
										{/each}
									</div>
								{/if}
								<Combobox
									searchable
									class="max-w-sm"
									options={catalog
										.filter((model) => !a.models.includes(model.id))
										.map((model) => ({
											value: model.id,
											label: model.label,
											keywords: model.id,
											...(model.provider === undefined ? {} : { group: model.provider })
										}))}
									value={null}
									placeholder={a.models.length === 0 ? t('Every model') : t('Add a model')}
									aria-label={t('Models members may use')}
									onChange={(id) => {
										if (id !== null) a.models = [...a.models, id];
									}}
								/>
							</fieldset>
						{/if}
						<Cluster gap="sm"><Button type="submit">{t('Save')}</Button></Cluster>
					</form>
				{/snippet}
				{@render card(
					t('Assistant'),
					t('Spending limits and the models members may use. Changes apply to the next message.'),
					assistantForm
				)}
			{/if}
		{:else if tab === 'integrations'}
			{#snippet envoysTab()}
				<Integrations
					{api}
					{bolt}
					{t}
					settings={s}
					locale={chosenLocale(workspace.locale)}
					{integrationSetups}
					reload={load}
				/>
			{/snippet}
			{#snippet keysTab()}
				<Table
					of={keys}
					key="keys"
					onOpen={show('key')}
					toolbar={{
						title: t('API keys'),
						description: t('Keys for programmatic access. A new key is shown once.'),
						new: () => (creating = 'key')
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
							hint={t('Issue a key so a source team can call this workspace.')}
						/>
					{/snippet}
				</Table>
			{/snippet}
			{#snippet mcpTab()}
				<Table
					of={remotes}
					key="mcp-servers"
					onOpen={show('remote')}
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
				level={2}
				orientation="horizontal"
				tabs={[
					{ name: 'envoys', title: t('Envoys'), icon: 'lucide:bot', body: envoysTab },
					{ name: 'keys', title: t('API keys'), icon: 'lucide:key-round', body: keysTab },
					{ name: 'mcp', title: t('MCP servers'), icon: 'lucide:server', body: mcpTab }
				]}
			/>
		{:else if tab === 'secrets'}
			<Table
				of={secrets}
				key="secrets"
				onOpen={(x) => {
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
{/if}

<!-- the open row's sheet -->
{#if open !== null && s !== null}
	{@const close = () => (open = null)}
	{#if open.kind === 'member'}
		{@const u = members.find((x) => x.id === open?.id)}
		{#if u !== undefined}
			<DetailSheet
				title={u.name || u.email}
				acts={memberActs(u)}
				onClose={close}
				fields={[
					{ label: t('Email'), value: u.email },
					{ label: t('Mobile number'), value: u.phone },
					{ label: t('Kind'), value: u.kind },
					{ label: t('Last seen'), value: when(u.last_seen) }
				]}
			>
				<div class="flex flex-col gap-3 border-t pt-3 text-sm">
					<label class="flex flex-col gap-1"
						><span class="text-meta">{t('Team')}</span>
						<Combobox
							size="sm"
							clearable
							placeholder={t('No team')}
							options={named(s.teams)}
							value={u.team_id}
							onChange={(team) => fork(op('assignTeam', { id: u.id, team }))}
							aria-label={t('Team')}
						/></label
					>
					<label class="flex items-center gap-2"
						><Checkbox
							checked={u.admin}
							disabled={u.external}
							onCheckedChange={(admin) => fork(op('setAdmin', { id: u.id, admin }))}
						/>
						{t('Admin')}</label
					>
					<label class="flex items-center gap-2"
						><Checkbox
							checked={u.active}
							onCheckedChange={(on) => fork(op(on ? 'reactivate' : 'deactivate', { id: u.id }))}
						/>
						{t('Active')}</label
					>
					<label class="flex flex-col gap-1"
						><span class="text-meta">{t('Mobile number')}</span>
						<PhoneInput
							value={handles.phone !== undefined ? handles.phone : u.phone || null}
							onChange={(v) => (handles.phone = typeof v === 'string' ? v : null)}
						/></label
					>
					<label class="flex flex-col gap-1"
						><span class="text-meta">{t('Telegram')}</span>
						<Input
							class="h-8"
							placeholder="@handle"
							aria-label={t('Telegram')}
							value={handles.telegram ?? u.telegram}
							oninput={(e) => (handles.telegram = e.currentTarget.value)}
						/></label
					>
					<Cluster
						><Button
							size="sm"
							disabled={Object.keys(handles).length === 0}
							onclick={() => fork(saveHandles(u.id))}>{t('Save')}</Button
						></Cluster
					>
				</div>
			</DetailSheet>
		{/if}
	{:else if open.kind === 'invitation'}
		{@const i = invitations.find((x) => x.id === open?.id)}
		{#if i !== undefined}
			<DetailSheet
				title={i.email}
				acts={invitationActs(i)}
				onClose={close}
				fields={[
					{ label: t('Team'), value: i.team },
					{ label: t('Status'), value: i.status },
					{ label: t('External'), value: i.external ? t('Yes') : t('No') },
					{ label: t('Expires'), value: when(i.expires_at) }
				]}
			/>
		{/if}
	{:else if open.kind === 'key'}
		{@const k = keys.find((x) => x.id === open?.id)}
		{#if k !== undefined}
			<DetailSheet
				title={k.name}
				acts={keyActs(k)}
				onClose={close}
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
			<DetailSheet title={r.name} onClose={close} fields={[{ label: t('URL'), value: r.url }]} />
		{/if}
	{:else if open.kind === 'secret'}
		{@const x = secrets.find((y) => y.id === open?.id)}
		{#if x !== undefined}
			<DetailSheet
				title={x.label}
				acts={secretActs(x)}
				onClose={close}
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
					<Button size="sm" type="submit" disabled={secretValue === ''}>{t('Set')}</Button>
				</form>
			</DetailSheet>
		{/if}
	{/if}
{/if}
{#if explained !== null}
	<DetailSheet
		title={t('What {who} holds').replace('{who}', explained.who)}
		onClose={() => (explained = null)}
		fields={[{ label: t('Grants'), value: explained.value }]}
	/>
{/if}

<!-- The API key secret is shown once. -->
<Dialog.Root
	open={creating !== null}
	onOpenChange={(o) => {
		if (!o) closeDialog();
	}}
>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<Dialog.Title>{creating === null ? '' : t(CREATE_TITLES[creating])}</Dialog.Title>
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
					void create();
				}}
			>
				{#if creating === 'invite'}
					<label class="flex flex-col gap-1"
						>{t('Bulk invitations')}<Textarea
							bind:value={bulkAddresses}
							aria-label={t('Bulk invitations')}
						/></label
					>
					<p class="text-meta">
						{t(
							'Enter one email or international mobile number per line, up to 1000 people. Leave blank to invite one person below.'
						)}
					</p>
					<Input
						class="h-8"
						type="email"
						placeholder={t('Email')}
						aria-label={t('Email')}
						required={form.phone === null && !bulkAddresses.trim()}
						bind:value={form.email}
					/>
					<PhoneInput
						value={form.phone}
						onChange={(v) => (form.phone = typeof v === 'string' ? v : null)}
					/>
					<Combobox
						size="sm"
						clearable
						placeholder={t('No team')}
						aria-label={t('Team')}
						options={named(s.teams)}
						value={form.team || null}
						onChange={(v) => (form.team = v ?? '')}
					/>
					<label class="flex items-center gap-2 text-sm"
						><Checkbox bind:checked={form.external} /> {t('External')}</label
					>
				{:else if creating === 'key'}
					<Input
						class="h-8"
						placeholder={t('Key name')}
						aria-label={t('Key name')}
						required
						bind:value={form.keyName}
					/>
					<Combobox
						size="sm"
						clearable
						placeholder={t('No team')}
						aria-label={t('Team')}
						options={named(s.teams)}
						value={form.keyTeam || null}
						onChange={(v) => (form.keyTeam = v ?? '')}
					/>
				{/if}
				{#if error !== null}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
				<Dialog.Footer>
					<Button variant="outline" onclick={closeDialog}>{t('Cancel')}</Button>
					<Button type="submit" disabled={submitting}
						>{creating === null ? '' : t(CREATE_TITLES[creating])}</Button
					>
				</Dialog.Footer>
			</form>
		{/if}
	</Dialog.Content>
</Dialog.Root>
