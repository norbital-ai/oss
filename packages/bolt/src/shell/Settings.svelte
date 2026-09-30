<!--
	Settings (§5.11.1, §5.11.4), administrators only; every system collection is ui's `Table` (search, filter and sort,
	CSV, a row opens its detail sheet with the row's actions), as staging's settings were. People: Members, Teams (the
	hierarchy as a Svelte Flow graph), Invitations and Assignments. Organization (the workspace and its branding), Audit
	(identity history, newest first) and Automations (runs). System pages: Channels, Integrations (API keys, issued once
	and shown once; collection integrations, paused or resumed here; connections and MCP servers) and Environment secrets
	(set or unset, never a value). Every change is one identity verb; the host re-checks the administrator.
-->
<script lang="ts">
	import { Cluster, Stack } from '@norbital-ai/ui/layout';
	import type { Snippet } from 'svelte';
	import { watch } from 'runed';
	import { Button, Checkbox, Combobox, Dialog, Input, PhoneInput, Table, Tabs } from '@norbital-ai/ui';
	import type { Json } from '../decl/values.ts';
	import type { ChannelConnection } from '../engine/channels/connection.ts';
	import type { ChannelMessage, Settings } from './data.ts';
	import { based, type SettingsTab, type ShellBoot } from './nav.ts';
	import type { Answer, ShellApi, ShellBolt } from './runtime.ts';
	import type { Act } from './Acts.svelte';
	import Acts from './Acts.svelte';
	import Connection from './channels/Connection.svelte';
	import { connectionLabel, type ConnectLoader } from './channels/connect.ts';
	import DetailSheet from './DetailSheet.svelte';
	import Runs from './Runs.svelte';
	import SystemPage from './SystemPage.svelte';
	import TeamFlow from './TeamFlow.svelte';
	import { subtree } from './teams.ts';

	let { api, bolt, t, tab, workspace, connects, run = null, onRun }: {
		api: ShellApi; bolt: ShellBolt; t: (key: string) => string; tab: SettingsTab; workspace: ShellBoot['workspace'];
		/** The workspace's own `+*.connect.svelte`, by channel name; bolt's own provider for the transport is the fallback. */
		connects?: { readonly [channel: string]: ConnectLoader } | undefined;
		run?: string | null; onRun: (id: string | null) => void;
	} = $props();

	const TITLES: { readonly [k in SettingsTab]: string } = { people: 'People', organization: 'Organization', audit: 'Audit', automations: 'Automations',
		channels: 'Channels', integrations: 'Integrations', secrets: 'Environment secrets' };
	let s = $state<Settings | null>(null);
	let error = $state<string | null>(null);
	async function load(): Promise<void> {
		const r = await api.settings();
		if (r.ok) s = r.value;
		else error = r.error.message;
	}
	void load();
	/** One settings verb; the page re-reads after it. The answer's value (a new key) is returned. */
	async function op(name: string, input: { [k: string]: Json | undefined }): Promise<Json | undefined> {
		error = null;
		const r = await api.settingsOp(name, JSON.parse(JSON.stringify(input)) as Json);
		if (!r.ok) return void (error = r.error.message);
		await load();
		return r.value;
	}
	/** Rule 39: a member id, or `{ team }`. */
	async function preview(target: string | { team: string }): Promise<void> {
		const r = await api.preview(target);
		if (r.ok) location.assign(based('/'));
		else error = r.error.message;
	}
	// `access.explain` (L-BOLT-234): what a member or team holds, in a sheet
	let explained = $state<{ who: string; value: Json } | null>(null);
	async function explain(who: string, target: { user: string } | { team: string }): Promise<void> {
		const r = await api.explain(target);
		if (r.ok) explained = { who, value: r.value };
		else error = r.error.message;
	}

	const str = (v: Json | undefined) => v === null || v === undefined ? '' : String(v);
	const when = (v: Json | undefined) => typeof v === 'string' && v !== '' ? new Date(v).toLocaleString(bolt.locale) : '—';
	const named = (rows: readonly { readonly [k: string]: Json }[]) => rows.map((r) => ({ value: str(r['id']), label: str(r['name']) || str(r['email']) || str(r['phone']) }));
	const TABLES: { readonly [table: string]: string } = { sys_user: 'member', sys_team: 'team', sys_assignment: 'assignment', sys_invitation: 'invitation' };

	// ── rows: the settings read projected per table (staging's in-memory collections) ──
	const teamName = (id: Json | undefined) => str(s?.teams.find((x) => x['id'] === id)?.['name']);
	const members = $derived((s?.members ?? []).map((u) => ({ id: str(u['id']), name: str(u['name']), email: str(u['email']), phone: str(u['phone']), kind: t(str(u['kind'])), external: u['kind'] === 'external',
		team: teamName(u['team']), team_id: str(u['team']) || null, admin: u['admin'] === true, active: u['active'] === true, last_seen: str(u['last_seen']) || null })));
	const teams = $derived((s?.teams ?? []).map((x) => ({ id: str(x['id']), name: str(x['name']), parent: str(x['parent']) || null })));
	const invitations = $derived((s?.invitations ?? []).map((i) => ({ id: str(i['id']), email: str(i['email']) || str(i['phone']), team: teamName(i['team']), external: i['external'] === true,
		status: t(str(i['status'])), state: str(i['status']), expires_at: str(i['expires_at']) })));
	const principal = (type: Json | undefined, id: Json | undefined) => type === 'sys_team' ? teamName(id) : type === 'sys_user'
		? str(s?.members.find((u) => u['id'] === id)?.['name']) : str(s?.keys.find((k) => k['id'] === id)?.['name']);
	const TYPES: { readonly [type: string]: string } = { sys_user: 'Member', sys_team: 'Team', sys_api_key: 'API key' };
	const assignments = $derived((s?.assignments ?? []).map((a) => ({ id: str(a['id']), who: principal(a['principal_type'], a['principal']),
		type: t(TYPES[str(a['principal_type'])] ?? str(a['principal_type'])), policy: str(a['policy']), scope: a['scope'] ?? null })));
	const keys = $derived((s?.keys ?? []).map((k) => ({ id: str(k['id']), name: str(k['name']), prefix: `nbk_${str(k['prefix'])}_…`,
		scope: (s?.assignments ?? []).filter((a) => a['principal_type'] === 'sys_api_key' && a['principal'] === k['id']).map((a) => str(a['policy'])).join(', '),
		created_at: str(k['created_at']), last_used_at: str(k['last_used_at']) || null, revoked: k['revoked_at'] !== null && k['revoked_at'] !== undefined })));
	const audit = $derived((s?.audit ?? []).map((e) => ({ id: `${e.collection}/${e.record}/${e.revision}`, at: e.at,
		who: e.actor?.startsWith('member:') ? str(s?.members.find((u) => u['id'] === e.actor!.slice(7))?.['name']) || e.actor : e.actor ?? t('host'),
		change: `${t(e.op)} · ${t(TABLES[e.collection] ?? e.collection)}`, fields: typeof e.changes === 'object' && e.changes !== null ? Object.keys(e.changes).filter((k) => k !== 'revision').join(', ') : '',
		changes: e.changes })));
	// ── a channel's connection: the host owns the socket, so it publishes the state and this page only draws it ──
	// One stream per channel for as long as the tab is open, not per open sheet: the stream is what carries a rotating QR
	// and a reconnect, and a status column that only refreshes when a sheet opens is not a status column.
	let connections = $state<Record<string, ChannelConnection | null>>({});
	let connectionErrors = $state<Record<string, string>>({});
	/** The pairing this page is waiting on, so the two verbs can say they are running and refuse a second press. */
	let pairing = $state<Record<string, boolean>>({});
	watch(
		// a joined key, not the array: the getter builds a new array each time it runs, and a stream per re-render is a
		// socket per keystroke somewhere else
		() => (tab === 'channels' ? (s?.channels ?? []).map((c) => c.name).join(',') : ''),
		(key) => {
			const streams = key === '' ? [] : key.split(',').map((name) => api.transport.watch(name,
				(c) => { connections[name] = c; delete connectionErrors[name]; },
				() => { connectionErrors[name] = t('The host stopped reporting this channel.'); }));
			return () => { for (const stream of streams) stream.close(); };
		}
	);
	/** The host's refusal, verbatim: a provider names what is wrong, and replacing that throws it away. */
	async function transportOp(name: string, run: () => Promise<Answer<ChannelConnection>>): Promise<void> {
		if (pairing[name] === true) return; // one unresolved pairing at a time: a second press opens a second socket
		pairing[name] = true;
		try {
			const r = await run();
			if (!r.ok) connectionErrors[name] = r.error.message;
			else { connections[name] = r.value; delete connectionErrors[name]; }
		} finally {
			pairing[name] = false;
		}
	}
	const pair = (name: string, input?: Json) => transportOp(name, () => api.transport.pair(name, input ?? {}));
	const unpair = (name: string) => transportOp(name, () => api.transport.unpair(name));

	const channels = $derived((s?.channels ?? []).map((c) => ({ id: c.name, name: c.name, transport: str(c.transport), address: str(c.address), sent: c.delivery.sent,
		queued: c.delivery.pending, retrying: c.delivery.retrying, failed: c.delivery.failed, next_retry: c.delivery.nextRetry, last_error: c.delivery.lastError,
		connection: connectionLabel(connections[c.name] ?? null, t) })));
	const remotes = $derived(s === null ? [] : [
		...s.integrations.map((i) => ({ id: `integration:${i.name}`, name: i.name, kind: t('Integration'), detail: str(i.direction), status: i.paused ? t('paused') : t('active'), paused: i.paused })),
		...s.connections.map((c) => ({ id: `connection:${c.name}`, name: c.name, kind: t('Connection'), detail: typeof c.auth === 'object' && c.auth !== null ? Object.keys(c.auth).join(', ') : t('no auth'), status: '', paused: null })),
		...s.mcp.map((m) => ({ id: `mcp:${m.name}`, name: m.name, kind: 'MCP', detail: str(m.url), status: '', paused: null }))]);
	const secrets = $derived((s?.secrets ?? []).map((x) => ({ id: x.name, label: x.label, name: x.name, status: x.set === null ? t('unknown') : x.set ? t('set') : t('unset'), set: x.set })));

	// ── each row's actions: its table column and its detail sheet ──
	type Member = (typeof members)[number];
	type Invitation = (typeof invitations)[number];
	type Assignment = (typeof assignments)[number];
	type Key = (typeof keys)[number];
	type Remote = (typeof remotes)[number];
	type Secret = (typeof secrets)[number];
	const memberActs = (u: Member): Act[] => u.active && !u.admin
		? [{ label: t('Preview as'), run: () => preview(u.id), variant: 'outline' }, { label: t('Explain'), run: () => explain(u.name || u.email, { user: u.id }) }] : [];
	const invitationActs = (i: Invitation): Act[] => [
		...(i.state === 'open' || i.state === 'expired' ? [{ label: t('Resend'), run: () => op('resendInvitation', { id: i.id }) }] : []),
		...(i.state === 'open' ? [{ label: t('Revoke'), run: () => op('revokeInvitation', { id: i.id }) }] : [])];
	const assignmentActs = (a: Assignment): Act[] => [{ label: t('Remove'), run: () => op('unassign', { id: a.id }) }];
	const keyActs = (k: Key): Act[] => k.revoked ? [] : [{ label: t('Rotate'), run: () => rotate(k.id) },
		{ label: t('Revoke'), run: () => { if (confirm(t('Revoke the key {name}? Programs using it stop at once.').replace('{name}', k.name))) void op('revokeKey', { id: k.id }); }, variant: 'destructive' }];
	const remoteActs = (r: Remote): Act[] => r.paused === null ? [] : [{ label: r.paused ? t('Resume') : t('Pause'), run: () => op(r.paused ? 'resumeIntegration' : 'pauseIntegration', { name: r.name }) }];
	const secretActs = (x: Secret): Act[] => x.set === true ? [{ label: t('Clear'), run: () => op('clearSecret', { name: x.name }) }] : [];

	// ── the open row (one sheet at a time) and the create dialog ──
	type Open = { kind: 'member' | 'team' | 'invitation' | 'assignment' | 'key' | 'audit' | 'channel' | 'remote' | 'secret'; id: string };
	let open = $state<Open | null>(null);
	/**
	 * The open channel's raw messages, both directions, newest first (its Messages tab): read when the sheet opens and on
	 * Refresh; Older reads the page before the last one shown.
	 */
	let channelLog = $state<{ channel: string; rows: ChannelMessage[]; more: boolean; error: string | null } | null>(null);
	async function readChannel(channel: string, older = false): Promise<void> {
		const before = older ? channelLog?.rows.at(-1)?.seq : undefined;
		const r = await api.channelMessages(channel, before);
		if (open?.kind !== 'channel') return;
		channelLog = !r.ok ? { channel, rows: channelLog?.rows ?? [], more: false, error: r.error.message }
			: { channel, rows: older ? [...(channelLog?.rows ?? []), ...r.value] : r.value, more: r.value.length === 100, error: null };
	}
	watch(() => (open?.kind === 'channel' ? channels.find((x) => x.id === open?.id)?.name : undefined), (name) => {
		channelLog = null;
		if (name !== undefined) void readChannel(name);
	});
	const show = (kind: Open['kind']) => (row: { id: string }) => (open = { kind, id: row.id });
	let peopleTab = $state('members');
	type Creating = 'invite' | 'assign' | 'team' | 'key';
	let creating = $state<Creating | null>(null);
	let form = $state({ email: '', phone: null as string | null, team: '', external: false, teamName: '', parent: '', keyName: '', type: 'sys_user', principal: '', policy: '' });
	/** A new or rotated key, shown once in the dialog. */
	let issued = $state<string | null>(null);
	const keyOf = (v: Json | undefined) => { const k = typeof v === 'object' && v !== null && 'key' in v ? v.key : null; return typeof k === 'string' ? k : null; };
	async function create(): Promise<void> {
		const c = creating;
		const v = c === 'invite' ? await op('invite', { email: form.email || undefined, phone: form.phone ?? undefined, team: form.team || undefined, external: form.external })
			: c === 'assign' ? await op('assign', { type: form.type, principal: form.principal, policy: form.policy })
			: c === 'team' ? await op('createTeam', { name: form.teamName, parent: form.parent || null })
			: await op('issueKey', { name: form.keyName });
		if (v === undefined) return; // refused: the dialog stays with the page's error
		if (c === 'key') issued = keyOf(v);
		else creating = null;
	}
	async function rotate(id: string): Promise<void> {
		const key = keyOf(await op('rotateKey', { id }));
		if (key !== null) { issued = key; creating = 'key'; }
	}
	function closeDialog(): void {
		creating = null;
		issued = null;
		form = { ...form, email: '', phone: null, teamName: '', parent: '', keyName: '', principal: '', policy: '' };
	}
	const CREATE_TITLES: { readonly [k in Creating]: string } = { invite: 'Invite', assign: 'Assign a policy', team: 'Create team', key: 'Issue key' };

	// L-COL-199: the workspace's name and logo, when the host lets an administrator edit them; a saved change reloads the shell's branding
	// svelte-ignore state_referenced_locally
	let brand = $state({ name: workspace.name, logo: workspace.logo ?? null as string | null });
	/** The host's ceiling on an inline logo (a `data:` URL's length). */
	const LOGO_MAX = 256 * 1024;
	function pickLogo(file: File | undefined): void {
		if (file === undefined) return;
		const reader = new FileReader();
		reader.onload = () => {
			const url = String(reader.result);
			if (!/^data:image\/(png|svg\+xml|webp|jpeg);base64,/.test(url) || url.length > LOGO_MAX) error = t('The logo must be a PNG, SVG, WebP or JPEG image of at most 256 KiB.');
			else { error = null; brand.logo = url; }
		};
		reader.readAsDataURL(file);
	}
	async function saveBrand(): Promise<void> {
		error = null;
		const r = await api.organization(brand.name.trim(), brand.logo);
		if (r.ok) location.reload();
		else error = r.error.message;
	}
	function removeTeam(id: string, name: string): void {
		if (confirm(t('Delete the team {name}? Its members keep their access through other grants only.').replace('{name}', name))) void op('deleteTeam', { id }).then(() => (open = null));
	}
	let renamed = $state('');
	let secretValue = $state('');
</script>

{#snippet card(title: string, description: string, body: Snippet)}
	<section class="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4">
		<div class="flex flex-col gap-0.5"><h2 class="text-sm font-medium">{title}</h2><p class="text-meta">{description}</p></div>
		{@render body()}
	</section>
{/snippet}
{#snippet at({ value }: { row: object; value: unknown })}<time class="tabular-nums">{when(typeof value === 'string' ? value : null)}</time>{/snippet}
{#snippet memberCell({ row }: { row: Member; value: unknown })}<Acts acts={memberActs(row)} />{/snippet}
{#snippet invitationCell({ row }: { row: Invitation; value: unknown })}<Acts acts={invitationActs(row)} />{/snippet}
{#snippet assignmentCell({ row }: { row: Assignment; value: unknown })}<Acts acts={assignmentActs(row)} />{/snippet}
{#snippet keyCell({ row }: { row: Key; value: unknown })}<Acts acts={keyActs(row)} />{/snippet}
{#snippet remoteCell({ row }: { row: Remote; value: unknown })}<Acts acts={remoteActs(row)} />{/snippet}
{#snippet secretCell({ row }: { row: Secret; value: unknown })}<Acts acts={secretActs(row)} />{/snippet}
{#snippet mono({ value }: { row: object; value: unknown })}<code class="font-mono text-xs">{String(value ?? '')}</code>{/snippet}

{#snippet membersTab()}
	<Table of={members} key="members" onOpen={show('member')} toolbar={{ title: t('Members'), description: t('Everyone with access to this workspace. Administrators see everything; preview a member to check what their teams grant.'), export: true }}
		columns={[{ field: 'name', label: t('Name') }, { field: 'email', label: t('Email') }, { field: 'phone', label: t('Mobile number') }, { field: 'team', label: t('Team') }, { field: 'kind', label: t('Kind') },
			{ field: 'admin', label: t('Admin') }, { field: 'active', label: t('Active') }, { field: 'last_seen', label: t('Last seen'), cell: at },
			{ field: 'id', label: t('Actions'), hide: 'narrow', cell: memberCell }]} />
{/snippet}
{#snippet teamsTab()}
	<Stack gap="sm">
		<Cluster gap="sm" justify="between">
			<p class="text-meta">{t('Teams group members; a team inherits the grants of its parent.')}</p>
			<Button size="sm" onclick={() => (creating = 'team')}>{t('Create team')}</Button>
		</Cluster>
		<TeamFlow {teams} members={members.map((m) => ({ name: m.name || m.email, team: m.team_id }))} selected={open?.kind === 'team' ? open.id : null}
			onSelect={(id) => { open = { kind: 'team', id }; renamed = teams.find((x) => x.id === id)?.name ?? ''; }} {t} />
	</Stack>
{/snippet}
{#snippet invitationsTab()}
	{#if s?.signup}
		<Cluster gap="sm" justify="between">
			<p class="text-meta">{t('This workspace lets people join by proving their address. Close sign-up to admit only invited members.')}</p>
			<label class="flex items-center gap-2 text-sm"><Checkbox checked={s.signup.open} onCheckedChange={(v) => void op('setSignup', { open: v === true })} /> {t('Newcomers may sign up')}</label>
		</Cluster>
	{/if}
	<Table of={invitations} key="invitations" onOpen={show('invitation')}
		toolbar={{ title: t('Invitations'), description: t('Invite people by email or mobile number. External members can never be administrators.'), new: () => (creating = 'invite'), export: true }}
		columns={[{ field: 'email', label: t('Address') }, { field: 'team', label: t('Team') }, { field: 'status', label: t('Status') }, { field: 'external', label: t('External') },
			{ field: 'expires_at', label: t('Expires'), cell: at }, { field: 'id', label: t('Actions'), hide: 'narrow', cell: invitationCell }]} />
{/snippet}
{#snippet assignmentsTab()}
	<Table of={assignments} key="assignments" onOpen={show('assignment')}
		toolbar={{ title: t('Assignments'), description: t('Policies granted to a member, a team or an API key.'), new: () => (creating = 'assign'), export: true }}
		columns={[{ field: 'who', label: t('Who') }, { field: 'type', label: t('Kind') }, { field: 'policy', label: t('Policy') }, { field: 'id', label: t('Actions'), hide: 'narrow', cell: assignmentCell }]} />
{/snippet}

{#if tab === 'automations'}
	<Runs {api} {bolt} {t} {run} {onRun} />
{:else}
<SystemPage name={`settings-${tab}`} title={t(TITLES[tab])} {error}>
	{#if s === null}
		<p class="text-sm text-muted-foreground">{t('Loading…')}</p>
	{:else if tab === 'people'}
		<Tabs level={2} orientation="horizontal" bind:value={peopleTab} tabs={[{ name: 'members', title: t('Members'), icon: 'lucide:users', body: membersTab },
			{ name: 'teams', title: t('Teams'), icon: 'lucide:network', body: teamsTab }, { name: 'invitations', title: t('Invitations'), icon: 'lucide:mail-plus', body: invitationsTab },
			{ name: 'assignments', title: t('Assignments'), icon: 'lucide:shield-check', body: assignmentsTab }]} />
	{:else if tab === 'organization'}
		{#snippet workspaceInfo()}
			<dl class="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm">
				<dt class="text-muted-foreground">{t('Workspace')}</dt><dd>{workspace.name}</dd>
				<dt class="text-muted-foreground">{t('Locale')}</dt><dd>{workspace.locale}</dd>
				<dt class="text-muted-foreground">{t('Time zone')}</dt><dd>{workspace.tz}</dd>
			</dl>
		{/snippet}
		{@render card(t('Workspace'), t('Set by the workspace source.'), workspaceInfo)}
		{#if workspace.organization}
			{#snippet branding()}
				<form class="flex flex-col gap-3" onsubmit={(e) => { e.preventDefault(); void saveBrand(); }}>
					<label class="flex flex-col gap-1 text-sm"><span class="text-muted-foreground">{t('Workspace name')}</span>
						<Input class="h-8" required maxlength={80} bind:value={brand.name} /></label>
					<div class="flex flex-wrap items-center gap-3 text-sm">
						<span class="text-muted-foreground">{t('Logo')}</span>
						{#if brand.logo !== null}<img src={brand.logo} alt={t('Logo')} class="size-10 rounded-sm border object-contain" />{/if}
						<input type="file" accept="image/png,image/svg+xml,image/webp,image/jpeg" aria-label={t('Logo')} class="text-xs"
							onchange={(e) => pickLogo(e.currentTarget.files?.[0])} />
						{#if brand.logo !== null}<Button size="sm" variant="ghost" onclick={() => (brand.logo = null)}>{t('Remove logo')}</Button>{/if}
					</div>
					<Cluster gap="sm"><Button type="submit" disabled={brand.name.trim() === ''}>{t('Save')}</Button></Cluster>
				</form>
			{/snippet}
			{@render card(t('Branding'), t('The name and logo every member sees.'), branding)}
		{/if}
	{:else if tab === 'audit'}
		<Table of={audit} key="audit" onOpen={show('audit')} toolbar={{ description: t('Identity changes, newest first.'), export: true }}
			columns={[{ field: 'at', label: t('When'), cell: at }, { field: 'who', label: t('Who') }, { field: 'change', label: t('Change') }, { field: 'fields', label: t('Fields') }]}>
			{#snippet empty()}<p class="text-sm text-muted-foreground">{t('No identity changes yet.')}</p>{/snippet}
		</Table>
	{:else if tab === 'channels'}
		<Table of={channels} key="channels" onOpen={show('channel')} toolbar={{ description: t('Open a channel to pair it with its provider and to see its outbound deliveries; an automatic retry is progress, only a settled failure is terminal.'), export: true }}
			columns={[{ field: 'name', label: t('Name') }, { field: 'transport', label: t('Transport') }, { field: 'address', label: t('Address') },
				{ field: 'connection', label: t('Connection') }, { field: 'sent', label: t('sent') },
				{ field: 'queued', label: t('queued') }, { field: 'retrying', label: t('retrying') }, { field: 'failed', label: t('failed') }, { field: 'last_error', label: t('Error') }]}>
			{#snippet empty()}<p class="text-sm text-muted-foreground">{t('The workspace declares no channels.')}</p>{/snippet}
		</Table>
	{:else if tab === 'integrations'}
		<Table of={keys} key="keys" onOpen={show('key')}
			toolbar={{ title: t('API keys'), description: t('Keys for programmatic access. A new key is shown once.'), new: () => (creating = 'key') }}
			columns={[{ field: 'name', label: t('Name') }, { field: 'prefix', label: t('Key'), cell: mono }, { field: 'scope', label: t('Scope') },
				{ field: 'created_at', label: t('Created'), cell: at }, { field: 'last_used_at', label: t('Last used'), cell: at }, { field: 'revoked', label: t('revoked') },
				{ field: 'id', label: t('Actions'), hide: 'narrow', cell: keyCell }]}>
			{#snippet empty()}<p class="text-sm text-muted-foreground">{t('No API keys yet.')}</p>{/snippet}
		</Table>
		<Table of={remotes} key="integrations" onOpen={show('remote')} toolbar={{ title: t('Integrations'), description: t('Collection integrations, connections and MCP servers the workspace declares.') }}
			columns={[{ field: 'name', label: t('Name') }, { field: 'kind', label: t('Kind') }, { field: 'detail', label: t('Detail') }, { field: 'status', label: t('Status') },
				{ field: 'id', label: t('Actions'), hide: 'narrow', cell: remoteCell }]}>
			{#snippet empty()}<p class="text-sm text-muted-foreground">{t('The workspace declares no integrations.')}</p>{/snippet}
		</Table>
	{:else if tab === 'secrets'}
		<Table of={secrets} key="secrets" onOpen={(x) => { open = { kind: 'secret', id: x.id }; secretValue = ''; }} toolbar={{ description: t('Values are write-only: open a secret to set it.') }}
			columns={[{ field: 'label', label: t('Name') }, { field: 'name', label: t('Variable'), cell: mono }, { field: 'status', label: t('Status') },
				{ field: 'id', label: t('Actions'), hide: 'narrow', cell: secretCell }]}>
			{#snippet empty()}<p class="text-sm text-muted-foreground">{t('The workspace declares no secrets.')}</p>{/snippet}
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
			<DetailSheet title={u.name || u.email} acts={memberActs(u)} onClose={close}
				fields={[{ label: t('Email'), value: u.email }, { label: t('Mobile number'), value: u.phone }, { label: t('Kind'), value: u.kind }, { label: t('Last seen'), value: when(u.last_seen) }]}>
				<div class="flex flex-col gap-3 border-t pt-3 text-sm">
					<label class="flex flex-col gap-1"><span class="text-meta">{t('Team')}</span>
						<Combobox size="sm" clearable placeholder={t('No team')} options={named(s.teams)} value={u.team_id} onChange={(team) => op('assignTeam', { id: u.id, team })} aria-label={t('Team')} /></label>
					<label class="flex items-center gap-2"><Checkbox checked={u.admin} disabled={u.external} onCheckedChange={(admin) => op('setAdmin', { id: u.id, admin })} /> {t('Admin')}</label>
					<label class="flex items-center gap-2"><Checkbox checked={u.active} onCheckedChange={(on) => op(on ? 'reactivate' : 'deactivate', { id: u.id })} /> {t('Active')}</label>
				</div>
			</DetailSheet>
		{/if}
	{:else if open.kind === 'team'}
		{@const tm = teams.find((x) => x.id === open?.id)}
		{#if tm !== undefined}
			{@const within = members.filter((m) => m.team_id === tm.id)}
			{@const below = subtree(teams, tm.id)}
			<DetailSheet title={tm.name} onClose={close} acts={[{ label: t('Preview as'), run: () => preview({ team: tm.id }), variant: 'outline' },
				{ label: t('Explain'), run: () => explain(tm.name, { team: tm.id }) }, { label: t('Delete'), run: () => removeTeam(tm.id, tm.name), variant: 'destructive' }]}>
				<form class="flex flex-wrap items-end gap-2" onsubmit={(e) => { e.preventDefault(); void op('renameTeam', { id: tm.id, name: renamed }); }}>
					<label class="flex min-w-48 flex-1 flex-col gap-1 text-sm"><span class="text-meta">{t('Team name')}</span><Input class="h-8" required bind:value={renamed} /></label>
					<Button size="sm" type="submit" disabled={renamed.trim() === '' || renamed.trim() === tm.name}>{t('Rename')}</Button>
				</form>
				<label class="flex flex-col gap-1 text-sm"><span class="text-meta">{t('Parent team')}</span>
					<Combobox size="sm" clearable placeholder={t('No parent')} options={named(s.teams.filter((x) => !below.has(str(x['id']))))} value={tm.parent}
						onChange={(parent) => op('moveTeam', { id: tm.id, parent })} aria-label={t('Parent team')} /></label>
				<section class="flex flex-col gap-2 border-t pt-3">
					<h3 class="text-sm font-medium">{t('Members')} <span class="text-meta tabular-nums">({within.length})</span></h3>
					{#if within.length === 0}<p class="text-meta">{t('Nobody is in this team yet.')}</p>{/if}
					<ul class="flex flex-col gap-1">
						{#each within as m (m.id)}
							<li class="flex items-center justify-between gap-2 rounded-md bg-muted/40 px-2 py-1 text-sm">
								<span class="min-w-0 truncate">{m.name || m.email}</span>
								<Button size="sm" variant="ghost" onclick={() => op('assignTeam', { id: m.id, team: null })}>{t('Remove')}</Button>
							</li>
						{/each}
					</ul>
					<Combobox size="sm" placeholder={t('Add a member')} aria-label={t('Add a member')} value={null}
						options={members.filter((m) => m.team_id !== tm.id).map((m) => ({ value: m.id, label: m.name || m.email }))}
						onChange={(id) => { if (id !== null) void op('assignTeam', { id, team: tm.id }); }} />
				</section>
			</DetailSheet>
		{/if}
	{:else if open.kind === 'invitation'}
		{@const i = invitations.find((x) => x.id === open?.id)}
		{#if i !== undefined}
			<DetailSheet title={i.email} acts={invitationActs(i)} onClose={close} fields={[{ label: t('Team'), value: i.team }, { label: t('Status'), value: i.status },
				{ label: t('External'), value: i.external ? t('Yes') : t('No') }, { label: t('Expires'), value: when(i.expires_at) }]} />
		{/if}
	{:else if open.kind === 'assignment'}
		{@const a = assignments.find((x) => x.id === open?.id)}
		{#if a !== undefined}
			<DetailSheet title={`${a.who} · ${a.policy}`} acts={assignmentActs(a)} onClose={close}
				fields={[{ label: t('Who'), value: a.who }, { label: t('Kind'), value: a.type }, { label: t('Policy'), value: a.policy }, { label: t('Scope'), value: a.scope ?? undefined }]} />
		{/if}
	{:else if open.kind === 'key'}
		{@const k = keys.find((x) => x.id === open?.id)}
		{#if k !== undefined}
			<DetailSheet title={k.name} acts={keyActs(k)} onClose={close} fields={[{ label: t('Key'), value: k.prefix }, { label: t('Scope'), value: k.scope },
				{ label: t('Created'), value: when(k.created_at) }, { label: t('Last used'), value: when(k.last_used_at) }, { label: t('Status'), value: k.revoked ? t('revoked') : t('active') }]} />
		{/if}
	{:else if open.kind === 'audit'}
		{@const e = audit.find((x) => x.id === open?.id)}
		{#if e !== undefined}
			<DetailSheet title={e.change} onClose={close} fields={[{ label: t('When'), value: when(e.at) }, { label: t('Who'), value: e.who }, { label: t('Changes'), value: e.changes }]} />
		{/if}
	{:else if open.kind === 'channel'}
		{@const c = channels.find((x) => x.id === open?.id)}
		{#if c !== undefined}
			<DetailSheet title={c.name} onClose={close} fields={[{ label: t('Transport'), value: c.transport }, { label: t('Address'), value: c.address },
				{ label: t('sent'), value: c.sent }, { label: t('queued'), value: c.queued }, { label: t('retrying'), value: c.retrying }, { label: t('failed'), value: c.failed },
				{ label: t('next'), value: c.next_retry === null ? undefined : when(c.next_retry) }, { label: t('Error'), value: c.last_error ?? undefined }]}>
				<div class="border-t pt-3">
				{#snippet connectionTab()}
					<Connection channel={c.name} transport={c.transport} connection={connections[c.name] ?? null} error={connectionErrors[c.name] ?? null}
						busy={pairing[c.name] === true} pair={(input) => pair(c.name, input)} unpair={() => unpair(c.name)} {t} workspace={connects} />
				{/snippet}
				{#snippet messagesTab()}
					<!-- the channel's raw traffic as stored: what came in and what went out, newest first -->
					<div class="flex flex-col gap-2 text-sm" data-channel-messages>
						<div class="flex items-center justify-between">
							<p class="text-xs text-muted-foreground">{t('Every message in and out of this channel, newest first.')}</p>
							<Button size="sm" variant="ghost" onclick={() => void readChannel(c.name)}>{t('Refresh')}</Button>
						</div>
						{#if channelLog?.error}<p role="alert" class="text-xs text-destructive">{channelLog.error}</p>{/if}
						{#if channelLog === null}
							<p class="text-xs text-muted-foreground">{t('Loading…')}</p>
						{:else if channelLog.rows.length === 0}
							<p class="text-xs text-muted-foreground">{t('No messages on this channel yet.')}</p>
						{:else}
							<ol class="flex flex-col gap-1.5">
								{#each channelLog.rows as x (x.id)}
									<li class="rounded-md border border-border/70 px-2.5 py-1.5" data-direction={x.direction} data-channel-message={x.id}>
										<p class="flex items-center gap-2 text-xs text-muted-foreground">
											<span class="font-medium text-foreground">{x.direction === 'inbound' ? '←' : '→'} {x.direction === 'inbound' ? (x.sender_name ?? x.sender ?? '') : t('sent')}</span>
											<span class="min-w-0 truncate">{x.kind === 'group' ? (x.title ?? x.thread) : x.thread}</span>
											<span class="flex-1"></span>
											{#if x.direction === 'outbound' && x.status !== null}<span class:text-destructive={x.status === 'failed'}>{x.status}</span>{/if}
											<time class="tabular-nums">{when(x.at)}</time>
										</p>
										<p class="whitespace-pre-wrap">{x.text ?? ''}{#if x.files > 0} <span class="text-xs text-muted-foreground">· {x.files} {t(x.files === 1 ? 'file' : 'files')}</span>{/if}</p>
										{#if x.error}<p class="text-xs text-destructive">{x.error}</p>{/if}
									</li>
								{/each}
							</ol>
							{#if channelLog.more}<Button size="sm" variant="ghost" onclick={() => void readChannel(c.name, true)}>{t('Older')}</Button>{/if}
						{/if}
					</div>
				{/snippet}
					<Tabs orientation="horizontal" value="connection" tabs={[
						{ name: 'connection', title: t('Connection'), icon: 'lucide:plug', body: connectionTab, keepAlive: true },
						{ name: 'messages', title: t('Messages'), icon: 'lucide:messages-square', body: messagesTab, keepAlive: true }]} />
				</div>
			</DetailSheet>
		{/if}
	{:else if open.kind === 'remote'}
		{@const r = remotes.find((x) => x.id === open?.id)}
		{#if r !== undefined}
			<DetailSheet title={r.name} acts={remoteActs(r)} onClose={close} fields={[{ label: t('Kind'), value: r.kind }, { label: t('Detail'), value: r.detail }, { label: t('Status'), value: r.status }]} />
		{/if}
	{:else if open.kind === 'secret'}
		{@const x = secrets.find((y) => y.id === open?.id)}
		{#if x !== undefined}
			<DetailSheet title={x.label} acts={secretActs(x)} onClose={close} fields={[{ label: t('Variable'), value: x.name }, { label: t('Status'), value: x.status }]}>
				<form class="flex flex-wrap items-end gap-2" onsubmit={(e) => { e.preventDefault(); void op('setSecret', { name: x.name, value: secretValue }).then(() => (secretValue = '')); }}>
					<label class="flex min-w-48 flex-1 flex-col gap-1 text-sm"><span class="text-meta">{t('New value')}</span>
						<Input class="h-8" type="password" autocomplete="off" required bind:value={secretValue} /></label>
					<Button size="sm" type="submit" disabled={secretValue === ''}>{t('Set')}</Button>
				</form>
			</DetailSheet>
		{/if}
	{/if}
{/if}
{#if explained !== null}
	<DetailSheet title={t('What {who} holds').replace('{who}', explained.who)} onClose={() => (explained = null)} fields={[{ label: t('Grants'), value: explained.value }]} />
{/if}

<!-- create: invite, assign, a team, an API key (whose secret is shown once, with a copy button) -->
<Dialog.Root open={creating !== null} onOpenChange={(o) => { if (!o) closeDialog(); }}>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<Dialog.Title>{creating === null ? '' : t(CREATE_TITLES[creating])}</Dialog.Title>
			{#if issued !== null}<Dialog.Description>{t('Copy this key now; it is not shown again:')}</Dialog.Description>{/if}
		</Dialog.Header>
		{#if issued !== null}
			<Input readonly value={issued} class="font-mono" aria-label={t('API key')} />
			<Dialog.Footer><Button onclick={closeDialog}>{t('Done')}</Button></Dialog.Footer>
		{:else if s !== null}
			<form class="flex flex-col gap-3" onsubmit={(e) => { e.preventDefault(); void create(); }}>
				{#if creating === 'invite'}
					<Input class="h-8" type="email" placeholder={t('Email')} aria-label={t('Email')} required={form.phone === null} bind:value={form.email} />
					<PhoneInput value={form.phone} onChange={(v) => (form.phone = typeof v === 'string' ? v : null)} />
					<Combobox size="sm" clearable placeholder={t('No team')} aria-label={t('Team')} options={named(s.teams)} value={form.team || null} onChange={(v) => (form.team = v ?? '')} />
					<label class="flex items-center gap-2 text-sm"><Checkbox bind:checked={form.external} /> {t('External')}</label>
				{:else if creating === 'assign'}
					<Combobox size="sm" value={form.type} onChange={(v) => { form.type = v ?? 'sys_user'; form.principal = ''; }} aria-label={t('Assign to')}
						options={[{ value: 'sys_user', label: t('Member') }, { value: 'sys_team', label: t('Team') }, { value: 'sys_api_key', label: t('API key') }]} />
					<Combobox size="sm" placeholder={t('Who')} aria-label={t('Who')} value={form.principal || null} onChange={(v) => (form.principal = v ?? '')}
						options={named(form.type === 'sys_user' ? s.members : form.type === 'sys_team' ? s.teams : s.keys)} />
					<Combobox size="sm" placeholder={t('Policy')} aria-label={t('Policy')} value={form.policy || null} onChange={(v) => (form.policy = v ?? '')}
						options={s.policies.map((p) => ({ value: p, label: p }))} />
				{:else if creating === 'team'}
					<Input class="h-8" placeholder={t('Team name')} aria-label={t('Team name')} required bind:value={form.teamName} />
					<Combobox size="sm" clearable placeholder={t('No parent')} aria-label={t('Parent team')} options={named(s.teams)} value={form.parent || null} onChange={(v) => (form.parent = v ?? '')} />
				{:else if creating === 'key'}
					<Input class="h-8" placeholder={t('Key name')} aria-label={t('Key name')} required bind:value={form.keyName} />
				{/if}
				{#if error !== null}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
				<Dialog.Footer>
					<Button variant="outline" onclick={closeDialog}>{t('Cancel')}</Button>
					<Button type="submit" disabled={creating === 'assign' && (form.principal === '' || form.policy === '')}>{creating === null ? '' : t(CREATE_TITLES[creating])}</Button>
				</Dialog.Footer>
			</form>
		{/if}
	</Dialog.Content>
</Dialog.Root>
