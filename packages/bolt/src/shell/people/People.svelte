<!-- The command center's People: administrators manage members and invitations; teams, policies and approval routes belong to source. -->
<script lang="ts">
	import { fork, observeOnce } from '@norbital-ai/ui/effect';
	import { Effect, Option, Schema } from 'effect';
	import type { Value } from '@norbital-ai/std/kind';
	import { Cluster } from '@norbital-ai/ui/layout';
	import { watch } from 'runed';
	import {
		Button,
		Checkbox,
		Combobox,
		Dialog,
		format,
		Input,
		PhoneInput,
		Table,
		Tabs,
		Textarea
	} from '@norbital-ai/ui';
	import type { Json } from '../../decl/values.ts';
	import { based } from '../nav.ts';
	import type { ShellApi } from '../api-types.ts';
	import type { Act } from '../Acts.svelte';
	import Acts from '../Acts.svelte';
	import DetailSheet from '../DetailSheet.svelte';

	let {
		api,
		t,
		locale
	}: {
		api: Pick<ShellApi, 'settings' | 'settingsOp' | 'preview' | 'explain'>;
		t: (key: string) => string;
		locale: string;
	} = $props();

	const read = observeOnce(() => api.settings());
	// a re-read keeps the last answer on screen, so an open sheet stays mounted while it refreshes
	let s = $state<NonNullable<typeof read.current> | null>(null);
	watch(
		() => read.current,
		(next) => {
			if (next !== undefined) s = next;
		}
	);
	let mutationError = $state<string | null>(null);
	const error = $derived(mutationError ?? read.error?.message ?? null);
	/** One settings verb; the page re-reads after it. The answer's value is returned. */
	const op = (name: string, input: { [key: string]: Json | undefined }) =>
		Effect.gen(function* () {
			mutationError = null;
			const body = Object.fromEntries(
				Object.entries(input).flatMap(([key, value]): [string, Json][] =>
					value === undefined ? [] : [[key, value]]
				)
			);
			const result = yield* Effect.result(api.settingsOp(name, body));
			yield* read.refetch();
			if (result._tag === 'Failure') {
				mutationError = result.failure.message;
				return undefined;
			}
			return result.success;
		});
	/** Rule 39: a member id, or `{ team }`. */
	const preview = Effect.fn('People.preview')(function* (target: string) {
		const r = yield* Effect.result(api.preview(target));
		if (r._tag === 'Success') location.assign(based('/'));
		else mutationError = r.failure.message;
	});
	// `access.explain` (L-BOLT-234): what a member holds, in a sheet
	let explained = $state<{ who: string; value: Json } | null>(null);
	const explain = Effect.fn('People.explain')(function* (who: string, user: string) {
		const r = yield* Effect.result(api.explain({ user }));
		if (r._tag === 'Success') explained = { who, value: r.success };
		else mutationError = r.failure.message;
	});

	const when = (v: Json | undefined) =>
		typeof v === 'string' && v !== '' ? format({ kind: 'instant' }, v, { locale }) : '—';
	const teams = $derived((s?.teams ?? []).map((r) => ({ value: r.id, label: r.name })));
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
	type Member = (typeof members)[number];
	type Invitation = (typeof invitations)[number];
	const memberActs = (u: Pick<Member, 'id' | 'active' | 'admin' | 'name' | 'email'>): Act[] =>
		u.active && !u.admin
			? [
					{ label: t('Preview as'), run: () => fork(preview(u.id)), variant: 'outline' },
					{ label: t('Explain'), run: () => fork(explain(u.name || u.email, u.id)) }
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

	// ── the open row (one sheet at a time) and the invite dialog ──
	let open = $state<{ kind: 'member' | 'invitation'; id: string } | null>(null);
	/** The open member's unsaved handles (rule 57: what a private envoy knows them by); a key left out is unchanged. */
	let handles = $state<{ phone?: string | null; telegram?: string }>({});
	const saveHandles = Effect.fn('People.saveHandles')(function* (id: string) {
		if ((yield* op('setHandles', { id, ...handles })) !== undefined) handles = {};
	});
	let tab = $state('members');
	let inviting = $state(false);
	let submitting = $state(false);
	let bulk = $state('');
	let form = $state({ email: '', phone: null as string | null, team: '', external: false });
	/** `inviteMany` answers the invitations whose delivery failed (`invite` refuses instead). */
	const Invited = Schema.Struct({ failed: Schema.Array(Schema.String) });
	function closeDialog(): void {
		inviting = false;
		bulk = '';
		form = { ...form, email: '', phone: null };
	}
	function invite(): void {
		if (submitting) return;
		submitting = true;
		const addresses = bulk
			.split(/[\n,;]+/)
			.map((address) => address.trim())
			.filter(Boolean)
			.map((address) => ({
				...(address.startsWith('+') ? { phone: address } : { email: address }),
				...(form.team ? { team: form.team } : {}),
				external: form.external
			}));
		fork(
			Effect.gen(function* () {
				const v = yield* addresses.length > 0
					? op('inviteMany', { invitations: addresses })
					: op('invite', {
							email: form.email || undefined,
							phone: form.phone ?? undefined,
							team: form.team || undefined,
							external: form.external
						});
				if (v === undefined) return; // refused: the dialog stays with the page's error
				closeDialog();
				if (Option.exists(Schema.decodeUnknownOption(Invited)(v), (i) => i.failed.length > 0))
					mutationError = t(
						'Invitations were saved, but some could not be delivered. Resend them from Invitations.'
					);
			}).pipe(
				Effect.ensuring(
					Effect.sync(() => {
						submitting = false;
					})
				)
			)
		);
	}
</script>

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

{#snippet membersTab()}
	{#key s}
		<Table
			of="sys_user"
			key="members"
			onOpen={(row) => {
				if (typeof row.id === 'string') {
					open = { kind: 'member', id: row.id };
					handles = {};
				}
			}}
			toolbar={{ title: t('Members'), new: () => (inviting = true), export: true }}
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
		<Cluster gap="sm" justify="end">
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
		onOpen={(row) => (open = { kind: 'invitation', id: row.id })}
		toolbar={{ title: t('Invitations'), new: () => (inviting = true), export: true }}
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

<div class="flex flex-col gap-3">
	{#if error !== null}<p
			role="alert"
			class="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
		>
			{error}
		</p>{/if}
	{#if s === null}
		<p class="text-sm text-muted-foreground">{t('Loading…')}</p>
	{:else}
		<Tabs
			level={2}
			orientation="horizontal"
			bind:value={tab}
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
	{/if}
</div>

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
							options={teams}
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
	{:else}
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
	{/if}
{/if}
{#if explained !== null}
	<DetailSheet
		title={t('What {who} holds').replace('{who}', explained.who)}
		onClose={() => (explained = null)}
		fields={[{ label: t('Grants'), value: explained.value }]}
	/>
{/if}

<Dialog.Root
	open={inviting}
	onOpenChange={(o) => {
		if (!o) closeDialog();
	}}
>
	<Dialog.Content class="max-w-md">
		<Dialog.Header><Dialog.Title>{t('Invite')}</Dialog.Title></Dialog.Header>
		{#if s !== null}
			<form
				class="flex flex-col gap-3"
				onsubmit={(e) => {
					e.preventDefault();
					invite();
				}}
			>
				<label class="flex flex-col gap-1"
					>{t('Bulk invitations')}<Textarea
						bind:value={bulk}
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
					required={form.phone === null && !bulk.trim()}
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
					options={teams}
					value={form.team || null}
					onChange={(v) => (form.team = v ?? '')}
				/>
				<label class="flex items-center gap-2 text-sm"
					><Checkbox bind:checked={form.external} /> {t('External')}</label
				>
				{#if error !== null}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
				<Dialog.Footer>
					<Button variant="outline" onclick={closeDialog}>{t('Cancel')}</Button>
					<Button type="submit" disabled={submitting}>{t('Invite')}</Button>
				</Dialog.Footer>
			</form>
		{/if}
	</Dialog.Content>
</Dialog.Root>
