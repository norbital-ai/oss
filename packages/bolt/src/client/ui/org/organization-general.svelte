<script lang="ts" module>
	/**
	 * The organization record this form edits, declared where the form is.
	 *
	 * It used to be a mapped type over the host's own `OrganizationProfile` schema, which is a module
	 * inside Colony — so this surface could only compile inside Colony. The five fields are what the
	 * host's operations endpoint reads and writes, and the decoding at the seam is already by field
	 * name, so restating them here costs nothing that the seam was not already paying.
	 */
	export type OrganizationDraft = {
		name: string;
		description: string;
		countryCode: string;
		companySize: string;
		logoKey: string | null;
	};

	/** What an organization reads as before anyone has saved one, so there is a single empty shape. */
	export const EMPTY_ORGANIZATION_DRAFT: OrganizationDraft = {
		name: '',
		description: '',
		countryCode: '',
		companySize: '',
		logoKey: null
	};
</script>

<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Button, buttonVariants } from '@norbital-ai/ui/button';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { CountryPicker } from '@norbital-ai/ui/country-picker';
	import { Input } from '@norbital-ai/ui/input';
	import { Bound, Cluster, Grid, Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { Textarea } from '@norbital-ai/ui/textarea';
	import { workspaceSession } from '../../session.js';

	/**
	 * The organization's own attributes, as the host holds them.
	 *
	 * The record is read by the surface that owns the host operations snapshot and handed down, but
	 * it is written from here: the form is the only thing that knows a field changed, and a save that
	 * travelled back up would need the draft to travel with it.
	 */
	let {
		profile = $bindable(),
		slug,
		loading,
		loadFailure
	}: {
		profile: OrganizationDraft;
		slug: string;
		loading: boolean;
		loadFailure: string | null;
	} = $props();

	/** One cell for both writes: a save and a logo change are never in flight together. */
	let busy = $state<'profile' | 'logo' | null>(null);
	let writeFailure = $state<string | null>(null);
	/** A failed read and a failed write are the same news to an operator, so they share one surface. */
	const failure = $derived(writeFailure ?? loadFailure);

	/** Ported: the same five buckets, and the same labels, the legacy Core app's form has always offered. */
	const COMPANY_SIZE_OPTIONS = [
		{ value: '', label: 'Select…' },
		{ value: '1-10', label: '1-10 employees' },
		{ value: '11-50', label: '11-50 employees' },
		{ value: '51-200', label: '51-200 employees' },
		{ value: '201-500', label: '201-500 employees' },
		{ value: '501+', label: '501+ employees' }
	];

	/** Ported from the legacy Core app, so a logo that is valid there is valid here. */
	const LOGO_TYPES: Readonly<Record<string, string>> = {
		'image/png': 'png',
		'image/jpeg': 'jpg',
		'image/webp': 'webp',
		'image/gif': 'gif',
		'image/svg+xml': 'svg'
	};
	const LOGO_MAX_BYTES = 2 * 1024 * 1024;

	/**
	 * Where a stored logo is served from, answered by the host rather than assembled here.
	 *
	 * This built `/api/files/<key>` itself, which is one host's route written into a framework
	 * surface. The host's own file store derives the media type from the extension, which is why the
	 * key still carries one.
	 */
	const logoUrl = $derived(
		profile.logoKey === null ? null : workspaceSession().files.urlFor(profile.logoKey)
	);

	/** Stores the whole record, including cleared fields, and reports the failure if it does not land. */
	const saveProfile = async (next: OrganizationDraft): Promise<boolean> => {
		writeFailure = null;
		try {
			await workspaceSession().operations.run({ action: 'organization', profile: next });
			profile = next;
			return true;
		} catch (cause) {
			writeFailure = cause instanceof Error ? cause.message : 'Unable to save the organization.';
			return false;
		}
	};

	/**
	 * Points the record at a logo object and drops the bytes it no longer references.
	 *
	 * The record is written first: an organization pointing at a key that was never stored would
	 * render a broken image forever, whereas an object nothing points at is only a charge. Storage is
	 * still metered, so the orphan is deleted — silently, because the record is already correct and
	 * the operator has no action to take about an object they cannot see.
	 */
	const pointLogoAt = async (key: string | null): Promise<void> => {
		const previous = profile.logoKey;
		busy = 'logo';
		if (await saveProfile({ ...profile, logoKey: key })) {
			if (previous !== null && previous !== key) {
				await workspaceSession()
					.files.remove(previous)
					.catch(() => undefined);
			}
		}
		busy = null;
	};
</script>

<Bound size="full">
	<Scroll name="Organization general settings">
		<Stack gap="md" fill>
			{#if loading}
				<Inline align="center" gap="sm" class="py-8 text-sm text-muted-foreground">
					<Icon icon="lucide:loader-2" class="size-4 animate-spin" />
					Loading…
				</Inline>
			{:else}
				{#if failure}
					<div
						class="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
						role="alert"
					>
						{failure}
					</div>
				{/if}

				<!-- The record as a card, matching the settings surfaces' card treatment: an outlined box on
				     the card background holds the form, spanning the tab content boundaries so it lines up
				     flush with the trigger strip above it. -->
				<Stack
					as="form"
					gap="md"
					class="rounded-lg border border-border bg-card p-4 sm:p-6"
					onsubmit={(event) => {
						event.preventDefault();
						void (async () => {
							busy = 'profile';
							await saveProfile({ ...profile, name: profile.name.trim() });
							busy = null;
						})();
					}}
				>
					<Stack gap="sm">
						<label class="text-sm font-medium" for="orgName">Organization name</label>
						<Input id="orgName" bind:value={profile.name} placeholder="Acme Inc." />
					</Stack>

					<Stack gap="sm">
						<label class="text-sm font-medium" for="orgSlug">Slug</label>
						<Input id="orgSlug" value={slug} disabled />
						<p class="text-meta">The URL-safe identifier. Cannot be changed.</p>
					</Stack>

					<Stack gap="sm">
						<label class="text-sm font-medium" for="orgDescription">Description</label>
						<Textarea
							id="orgDescription"
							bind:value={profile.description}
							placeholder="Briefly describe what your organization does."
							rows={3}
						/>
					</Stack>

					<Grid minimum="panel" gap="md">
						<Stack gap="sm">
							<span class="text-sm font-medium">Country</span>
							<CountryPicker bind:value={profile.countryCode} />
						</Stack>
						<Stack gap="sm">
							<span class="text-sm font-medium">Company size</span>
							<Combobox
								options={COMPANY_SIZE_OPTIONS}
								ariaLabel="Company size"
								value={profile.companySize}
								onValueChange={(value) => {
									profile.companySize = value ?? '';
								}}
								searchable={false}
								class="w-full"
							/>
						</Stack>
					</Grid>

					<Stack gap="sm">
						<span class="text-sm font-medium">Logo</span>
						<p class="text-meta">PNG, JPEG, WebP, GIF, or SVG up to 2 MB.</p>
						<Cluster gap="md">
							{#if logoUrl === null}
								<Inline
									align="center"
									justify="center"
									class="size-14 rounded-md border border-dashed text-muted-foreground"
								>
									<Icon icon="lucide:image" class="size-5" />
								</Inline>
							{:else}
								<img
									src={logoUrl}
									alt="Logo preview"
									class="size-14 rounded-md border bg-background object-contain"
								/>
							{/if}
							<Cluster gap="sm">
								<!--
									A label rather than a button that reaches for the input by id: the control that
									opens the picker and the input it opens are the same control to assistive
									technology, and nothing has to query the document to connect them. It wears the
									button recipe so it reads as one control with `Remove logo` beside it.
								-->
								<label
									class={buttonVariants({ variant: 'secondary' })}
									aria-disabled={busy !== null}
								>
									{#if busy === 'logo'}
										<Icon icon="lucide:loader-2" class="mr-2 size-4 animate-spin" />
									{/if}
									Upload logo
									<input
										type="file"
										class="sr-only"
										accept={Object.keys(LOGO_TYPES).join(',')}
										disabled={busy !== null}
										onchange={async (event) => {
											const input = event.currentTarget;
											const file = input.files?.[0];
											input.value = '';
											if (file === undefined) return;
											const extension = LOGO_TYPES[file.type];
											if (extension === undefined) {
												writeFailure = 'Use PNG, JPEG, WebP, GIF, or SVG.';
												return;
											}
											if (file.size > LOGO_MAX_BYTES) {
												writeFailure = 'Logo must be 2 MB or smaller.';
												return;
											}
											busy = 'logo';
											// Each upload takes a fresh key rather than overwriting a fixed one, so a
											// new URL is never served from a cache still holding the old image.
											const key = `org-branding/logo-${crypto.randomUUID()}.${extension}`;
											try {
												await workspaceSession().files.store(key, file);
											} catch (cause) {
												writeFailure =
													cause instanceof Error ? cause.message : 'Unable to store the logo.';
												busy = null;
												return;
											}
											await pointLogoAt(key);
										}}
									/>
								</label>
								{#if logoUrl !== null}
									<Button
										type="button"
										variant="ghost"
										disabled={busy !== null}
										onclick={() => pointLogoAt(null)}
									>
										Remove logo
									</Button>
								{/if}
							</Cluster>
						</Cluster>
					</Stack>

					<Inline justify="end" class="border-t pt-4">
						<Button type="submit" disabled={busy !== null || profile.name.trim() === ''}>
							{#if busy === 'profile'}
								<Icon icon="lucide:loader-2" class="mr-2 size-4 animate-spin" />
							{/if}
							Save changes
						</Button>
					</Inline>
				</Stack>
			{/if}
		</Stack>
	</Scroll>
</Bound>
