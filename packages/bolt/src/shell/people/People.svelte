<!-- The command center's People: administrators manage members and invitations; teams, policies and approval routes belong to source. -->
<script lang="ts">
	import { fork, observe_once } from '@norbital-ai/ui/effect';
	import { Effect, Option, Schema } from 'effect';
	import { csv_delimiter, csv_rows, csv_text } from '@norbital-ai/std/csv';
	import { Cluster } from '@norbital-ai/ui/layout';
	import { watch } from 'runed';
	import {
		Button,
		Checkbox,
		Combobox,
		Dialog,
		format,
		Icon,
		Input,
		PhoneInput,
		Table,
		Tabs
	} from '@norbital-ai/ui';
	import type { Json } from '../../decl/values.ts';
	import { based } from '../nav.ts';
	import type { ShellApi } from '../api-types.ts';
	import type { Act } from '../Acts.svelte';
	import Acts from '../Acts.svelte';
	import DetailSheet from '../DetailSheet.svelte';
	import type { SystemUiIntent } from '../../protocol/system-ui.ts';

	let {
		api,
		t,
		locale,
		configuration = null
	}: {
		api: Pick<ShellApi, 'settings' | 'settings_op' | 'preview'>;
		t: (key: string) => string;
		locale: string;
		configuration?: SystemUiIntent | null;
	} = $props();

	const read = observe_once(() => api.settings());
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
			const result = yield* Effect.result(api.settings_op(name, body));
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
	/** The open member's draft while Edit is on; Save applies only what changed. */
	type Draft = {
		team: string | null;
		admin: boolean;
		active: boolean;
		phone: string | null;
		telegram: string;
	};
	let draft = $state<Draft | null>(null);
	let saving = $state(false);
	const saveMember = Effect.fn('People.saveMember')(function* (u: Member, d: Draft) {
		const steps: { name: string; input: { [key: string]: Json | undefined } }[] = [
			...(d.team !== u.team_id ? [{ name: 'assign_team', input: { id: u.id, team: d.team } }] : []),
			...(d.admin !== u.admin ? [{ name: 'setAdmin', input: { id: u.id, admin: d.admin } }] : []),
			...(d.active !== u.active
				? [{ name: d.active ? 'reactivate' : 'deactivate', input: { id: u.id } }]
				: []),
			// rule 57: what a private envoy knows them by; a key left out is unchanged
			...((d.phone ?? '') !== u.phone || d.telegram !== u.telegram
				? [
						{
							name: 'setHandles',
							input: {
								id: u.id,
								...((d.phone ?? '') !== u.phone ? { phone: d.phone } : {}),
								...(d.telegram !== u.telegram ? { telegram: d.telegram } : {})
							}
						}
					]
				: [])
		];
		for (const step of steps) if ((yield* op(step.name, step.input)) === undefined) return;
		draft = null;
	});
	let tab = $state('members');
	let inviting = $state(false);
	let inviteTab = $state<'one' | 'bulk'>('one');
	let submitting = $state(false);
	let form = $state({ email: '', phone: null as string | null, team: '', external: false });
	let configured = $state<string | null>(null);
	watch([() => configuration, () => s], ([intent, settings]) => {
		if (intent === null || settings === null || configured === intent.key) return;
		configured = intent.key;
		if (intent.request.capability === 'member.invite') {
			tab = 'invitations';
			inviting = true;
		} else if (intent.request.capability === 'member.manage') {
			tab = 'members';
			open = { kind: 'member', id: intent.request.record };
		}
	});

	// ── bulk: a CSV of `email, phone, team, external`, one invitation per row ──
	type Invite = { email?: string; phone?: string; team?: string; external: boolean };
	const MAX = 1000;
	const TEMPLATE = `data:text/csv;charset=utf-8,${encodeURIComponent('email,phone,team,external\nana@example.com,,,false\n,+60123456789,,false\n')}`;
	let csv = $state<{ name: string; rows: Invite[]; errors: string[] } | null>(null);
	let over = $state(false);
	const line = (key: string, n: number, team = '') =>
		t(key).replace('{n}', String(n)).replace('{team}', team);
	function parse(name: string, text: string): void {
		const [head = [], ...lines] = csv_rows(text, csv_delimiter(text)).filter((r) =>
			r.some((c) => c.trim() !== '')
		);
		const col = (h: string) => head.findIndex((c) => c.trim().toLowerCase() === h);
		const [email, phone, team, external] = ['email', 'phone', 'team', 'external'].map(col);
		if (email === -1 && phone === -1)
			return void (csv = {
				name,
				rows: [],
				errors: [t('The header must name an email or phone column.')]
			});
		const errors: string[] = [];
		const rows = lines.flatMap((r, i): Invite[] => {
			const at = (c: number | undefined) =>
				c === undefined || c === -1 ? '' : (r[c] ?? '').trim();
			const n = i + 2;
			const [address, mobile, teamText] = [at(email), at(phone), at(team)];
			const teamId =
				teamText === ''
					? undefined
					: s?.teams.find(
							(x) => x.id === teamText || x.name.toLowerCase() === teamText.toLowerCase()
						)?.id;
			if (address === '' && mobile === '')
				errors.push(line('Line {n}: an email or a mobile number is required.', n));
			else if (mobile !== '' && !mobile.startsWith('+'))
				errors.push(line('Line {n}: a mobile number starts with + and its country code.', n));
			else if (teamText !== '' && teamId === undefined)
				errors.push(line('Line {n}: no team named {team}.', n, teamText));
			else
				return [
					{
						...(address === '' ? {} : { email: address }),
						...(mobile === '' ? {} : { phone: mobile }),
						...(teamId === undefined ? {} : { team: teamId }),
						external: /^(true|yes|y|1)$/i.test(at(external))
					}
				];
			return [];
		});
		if (rows.length > MAX) errors.push(t('At most 1000 rows.'));
		csv = { name, rows, errors };
	}
	const load = Effect.fn('People.loadCsv')(function* (file: File) {
		const bytes = yield* Effect.tryPromise({
			try: () => file.arrayBuffer(),
			catch: () => new Error(t('The file could not be read.'))
		}).pipe(
			Effect.catch((e) =>
				Effect.sync(() => void (csv = { name: file.name, rows: [], errors: [e.message] }))
			)
		);
		if (bytes !== undefined) parse(file.name, csv_text(new Uint8Array(bytes)));
	});

	/** `inviteMany` answers the invitations whose delivery failed (`invite` refuses instead). */
	const Invited = Schema.Struct({ failed: Schema.Array(Schema.String) });
	function openInvite(on: 'one' | 'bulk'): void {
		inviteTab = on;
		inviting = true;
	}
	function closeDialog(): void {
		inviting = false;
		csv = null;
		form = { ...form, email: '', phone: null };
	}
	const ready = $derived(
		inviteTab === 'bulk'
			? csv !== null && csv.errors.length === 0 && csv.rows.length > 0
			: form.email.trim() !== '' || form.phone !== null
	);
	function invite(): void {
		if (submitting || !ready) return;
		submitting = true;
		fork(
			Effect.gen(function* () {
				const v =
					inviteTab === 'bulk'
						? yield* op('inviteMany', { invitations: csv?.rows ?? [] })
						: yield* op('invite', {
								email: form.email.trim() || undefined,
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
	// the toolbar's Actions: the same CSV import as the dialog's Bulk import tab
	const importAction = $derived({
		icon: 'lucide:upload',
		name: t('Import invitations'),
		description: t('Invite people from a CSV file.'),
		run: () => openInvite('bulk')
	});
</script>

{#snippet at({ value }: { row: object; value: unknown })}<time class="tabular-nums"
		>{when(typeof value === 'string' ? value : null)}</time
	>{/snippet}
{#snippet invitationCell({ row }: { row: Invitation; value: unknown })}<Acts
		acts={invitationActs(row)}
	/>{/snippet}

{#snippet membersTab()}
	{#key s}
		<Table
			of="sys_user"
			key="members"
			on_open={(row) => {
				if (typeof row.id === 'string') {
					open = { kind: 'member', id: row.id };
					draft = null;
				}
			}}
			toolbar={{
				title: t('Members'),
				new: () => openInvite('one'),
				export: true,
				actions: [importAction]
			}}
			columns={[
				{ field: 'name', label: t('Name') },
				{ field: 'email', label: t('Email') },
				{ field: 'phone', label: t('Mobile number') },
				{ field: 'team', label: t('Team') },
				{ field: 'kind', label: t('Kind') },
				{ field: 'admin', label: t('Admin') },
				{ field: 'active', label: t('Active') },
				{ field: 'last_seen', label: t('Last seen'), cell: at }
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
					on_checked_change={(v) => fork(op('setSignup', { open: v === true }))}
				/>
				{t('Newcomers may sign up')}</label
			>
		</Cluster>
	{/if}
	<Table
		of={invitations}
		key="invitations"
		on_open={(row) => (open = { kind: 'invitation', id: row.id })}
		toolbar={{
			title: t('Invitations'),
			new: () => openInvite('one'),
			export: true,
			actions: [importAction]
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
	{@const close = () => {
		open = null;
		draft = null;
	}}
	{#if open.kind === 'member'}
		{@const u = members.find((x) => x.id === open?.id)}
		{#if u !== undefined}
			{#snippet memberFoot()}
				{#if draft === null}
					{#if u.active && !u.admin}<Button variant="outline" onclick={() => fork(preview(u.id))}
							>{t('Preview as')}</Button
						>{/if}
					<Button
						variant="outline"
						class="min-w-[4.25rem] justify-center"
						onclick={() =>
							(draft = {
								team: u.team_id,
								admin: u.admin,
								active: u.active,
								phone: u.phone || null,
								telegram: u.telegram
							})}>{t('Edit')}</Button
					>
				{:else}
					{@const d = draft}
					<Button variant="ghost" disabled={saving} onclick={() => (draft = null)}
						><Icon name="lucide:undo-2" class="size-3.5" />{t('Cancel')}</Button
					>
					<Button
						disabled={saving}
						onclick={() => {
							saving = true;
							fork(
								saveMember(u, d).pipe(
									Effect.ensuring(
										Effect.sync(() => {
											saving = false;
										})
									)
								)
							);
						}}
						data-member-save>{t('Save')}</Button
					>
				{/if}
			{/snippet}
			<DetailSheet
				title={u.name || u.email}
				on_close={close}
				footer={memberFoot}
				fields={[
					{ label: t('Email'), value: u.email },
					{ label: t('Mobile number'), value: u.phone },
					{ label: t('Kind'), value: u.kind },
					{ label: t('Last seen'), value: when(u.last_seen) },
					...(draft === null
						? [
								{ label: t('Team'), value: u.team },
								{ label: t('Admin'), value: u.admin ? t('Yes') : t('No') },
								{ label: t('Active'), value: u.active ? t('Yes') : t('No') },
								{ label: t('Telegram'), value: u.telegram }
							]
						: [])
				]}
			>
				{#if draft !== null}
					<div class="flex flex-col gap-3 border-t pt-3 text-sm" data-member-edit>
						<label class="flex flex-col gap-1"
							><span class="text-meta">{t('Team')}</span>
							<Combobox
								clearable
								placeholder={t('No team')}
								options={teams}
								value={draft.team}
								on_change={(team) => {
									if (draft !== null) draft.team = team;
								}}
								aria-label={t('Team')}
							/></label
						>
						<label class="flex items-center gap-2"
							><Checkbox bind:checked={draft.admin} disabled={u.external} />
							{t('Admin')}</label
						>
						<label class="flex items-center gap-2"
							><Checkbox bind:checked={draft.active} />
							{t('Active')}</label
						>
						<label class="flex flex-col gap-1"
							><span class="text-meta">{t('Mobile number')}</span>
							<PhoneInput
								value={draft.phone}
								on_change={(v) => {
									if (draft !== null) draft.phone = typeof v === 'string' ? v : null;
								}}
							/></label
						>
						<label class="flex flex-col gap-1"
							><span class="text-meta">{t('Telegram')}</span>
							<Input
								class="h-8"
								placeholder="@handle"
								aria-label={t('Telegram')}
								bind:value={draft.telegram}
							/></label
						>
					</div>
				{/if}
			</DetailSheet>
		{/if}
	{:else}
		{@const i = invitations.find((x) => x.id === open?.id)}
		{#if i !== undefined}
			<DetailSheet
				title={i.email}
				acts={invitationActs(i)}
				on_close={close}
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

{#snippet one()}
	<div class="flex flex-col gap-3 pt-3">
		<Input
			class="h-8"
			type="email"
			placeholder={t('Email')}
			aria-label={t('Email')}
			bind:value={form.email}
		/>
		<PhoneInput
			value={form.phone}
			on_change={(v) => (form.phone = typeof v === 'string' ? v : null)}
		/>
		<p class="text-meta">{t('Enter an email or a mobile number.')}</p>
		<Combobox
			clearable
			placeholder={t('No team')}
			aria-label={t('Team')}
			options={teams}
			value={form.team || null}
			on_change={(v) => (form.team = v ?? '')}
		/>
		<label class="flex items-center gap-2 text-sm"
			><Checkbox bind:checked={form.external} /> {t('External')}</label
		>
	</div>
{/snippet}
{#snippet bulk()}
	<div class="flex flex-col gap-3 pt-3">
		<label
			class={[
				'flex cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed px-4 py-8 text-center text-sm',
				over ? 'border-brand bg-brand-muted' : 'bg-muted/20'
			]}
			ondragover={(e) => {
				e.preventDefault();
				over = true;
			}}
			ondragleave={() => (over = false)}
			ondrop={(e) => {
				e.preventDefault();
				over = false;
				const file = e.dataTransfer?.files[0];
				if (file !== undefined) fork(load(file));
			}}
			data-invite-drop
		>
			<Icon name="lucide:upload" class="size-5 text-muted-foreground" />
			<span>{csv?.name ?? t('Drop a CSV file here, or click to choose one.')}</span>
			<input
				type="file"
				accept=".csv,text/csv"
				class="sr-only"
				onchange={(e) => {
					const file = e.currentTarget.files?.[0];
					if (file !== undefined) fork(load(file));
					e.currentTarget.value = '';
				}}
			/>
		</label>
		<p class="text-meta">
			{t(
				'Columns: email, phone, team, external. Each row needs an email or a mobile number; up to 1000 rows.'
			)}
			<a class="underline" href={TEMPLATE} download="invitations.csv">{t('Download template')}</a>
		</p>
		{#if csv !== null}
			{#if csv.errors.length > 0}
				<ul class="max-h-32 overflow-auto text-xs text-destructive" role="alert" data-invite-errors>
					{#each csv.errors as message (message)}<li>{message}</li>{/each}
				</ul>
			{:else}
				<p class="text-sm" role="status">
					{t('{n} people ready to invite').replace('{n}', String(csv.rows.length))}
				</p>
			{/if}
		{/if}
	</div>
{/snippet}

<Dialog.Root
	open={inviting}
	on_open_change={(o) => {
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
				<Tabs
					level={2}
					orientation="horizontal"
					value={inviteTab}
					on_value_change={(v) => (inviteTab = v === 'bulk' ? 'bulk' : 'one')}
					tabs={[
						{ name: 'one', title: t('One person'), icon: 'lucide:user-plus', body: one },
						{ name: 'bulk', title: t('Bulk import'), icon: 'lucide:upload', body: bulk }
					]}
				/>
				{#if error !== null}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
				<Dialog.Footer>
					<Button variant="outline" onclick={closeDialog}>{t('Cancel')}</Button>
					<Button type="submit" disabled={submitting || !ready}>{t('Invite')}</Button>
				</Dialog.Footer>
			</form>
		{/if}
	</Dialog.Content>
</Dialog.Root>
