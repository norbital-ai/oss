<script lang="ts" module>
	export { EMPTY_ORGANIZATION_DRAFT, type OrganizationDraft } from './organization-state.js';
</script>

<script lang="ts">
	import { Effect } from 'effect';
	import Icon from '@iconify/svelte';
	import { Button, buttonVariants } from '@norbital-ai/ui/button';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { CountryPicker } from '@norbital-ai/ui/country-picker';
	import { Input } from '@norbital-ai/ui/input';
	import { Bound, Cluster, Grid, Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { Textarea } from '@norbital-ai/ui/textarea';
	import { workspaceSession } from '#lib/client/session.js';
	import type { OrganizationDraft } from './organization-state.js';

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
		defaultName,
		loading,
		loadFailure
	}: {
		profile: OrganizationDraft;
		slug: string;
		defaultName?: string | undefined;
		loading: boolean;
		loadFailure: string | null;
	} = $props();
	/**
	 * A host record nobody has saved yet has no name. The workspace manifest remains the owner of
	 * its declared name, so the form projects that value until the operator edits or saves it rather
	 * than copying a query result into the host draft.
	 */
	const organizationName = $derived(profile.name || defaultName || '');

	/** One cell for both writes: a save and a logo change are never in flight together. */
	let busy = $state<'profile' | 'logo' | null>(null);
	let writeFailure = $state<string | null>(null);
	/** A failed read and a failed write are the same news to an operator, so they share one surface. */
	const failure = $derived(writeFailure ?? loadFailure);

	/** Five buckets, chosen so the labels stay readable in the select rather than to fit a range. */
	const COMPANY_SIZE_OPTIONS = [
		{ value: '', label: 'Select…' },
		{ value: '1-10', label: '1-10 employees' },
		{ value: '11-50', label: '11-50 employees' },
		{ value: '51-200', label: '51-200 employees' },
		{ value: '201-500', label: '201-500 employees' },
		{ value: '501+', label: '501+ employees' }
	];

	/** The raster and vector types a logo may be uploaded as; the extension is derived from the type. */
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
	const saveProfile = (next: OrganizationDraft): Effect.Effect<boolean> =>
		Effect.suspend(() => {
			writeFailure = null;
			return Effect.tryPromise(() =>
				workspaceSession().operations.run({ action: 'organization', profile: next })
			);
		}).pipe(
			Effect.map(() => {
				profile = next;
				return true;
			}),
			Effect.catch((cause) => {
				writeFailure = cause instanceof Error ? cause.message : 'Unable to save the organization.';
				return Effect.succeed(false);
			})
		);

	/**
	 * Points the record at a logo object and drops the bytes it no longer references.
	 *
	 * The record is written first: an organization pointing at a key that was never stored would
	 * render a broken image forever, whereas an object nothing points at is only a charge. Storage is
	 * still metered, so the orphan is deleted — silently, because the record is already correct and
	 * the operator has no action to take about an object they cannot see.
	 */
	const pointLogoAt = (key: string | null): Effect.Effect<void> =>
		Effect.gen(function* () {
			const previous = profile.logoKey;
			busy = 'logo';
			const saved = yield* saveProfile({ ...profile, logoKey: key });
			if (saved && previous !== null && previous !== key) {
				yield* Effect.tryPromise(() => workspaceSession().files.remove(previous)).pipe(
					Effect.catch(() => Effect.void)
				);
			}
			busy = null;
		});
</script>

<Bound size="full">
	<Scroll name="Organization general settings">
		<Stack gap="md" fill>
			{#if loading}
				<Inline align="center" gap="sm" class="text-sm text-muted-foreground" role="status">
					<Icon icon="lucide:loader-2" class="size-4 animate-spin" />
					Loading saved organization details…
				</Inline>
			{/if}
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
				aria-busy={loading}
				onsubmit={(event) => {
					event.preventDefault();
					void Effect.runPromise(
						Effect.gen(function* () {
							busy = 'profile';
							yield* saveProfile({ ...profile, name: organizationName.trim() });
							busy = null;
						})
					);
				}}
			>
				<fieldset disabled={loading} class="contents">
					<Stack gap="sm">
						<label class="text-sm font-medium" for="orgName">Organization name</label>
						<Input
							id="orgName"
							value={organizationName}
							placeholder="Acme Inc."
							oninput={(event) => (profile = { ...profile, name: event.currentTarget.value })}
						/>
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
									profile = { ...profile, companySize: value ?? '' };
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
									<Inline as="span" gap="sm" justify="center">
										{#if busy === 'logo'}
											<Icon icon="lucide:loader-2" class="size-4 animate-spin" />
										{/if}
										Upload logo
									</Inline>
									<input
										type="file"
										class="sr-only"
										accept={Object.keys(LOGO_TYPES).join(',')}
										disabled={busy !== null}
										onchange={(event) => {
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
											void Effect.runPromise(
												Effect.gen(function* () {
													const stored = yield* Effect.tryPromise(() =>
														workspaceSession().files.store(key, file)
													).pipe(
														Effect.catch((cause) => {
															writeFailure =
																cause instanceof Error
																	? cause.message
																	: 'Unable to store the logo.';
															busy = null;
															return Effect.succeed(null);
														})
													);
													if (stored !== null) yield* pointLogoAt(key);
												})
											);
										}}
									/>
								</label>
								{#if logoUrl !== null}
									<Button
										type="button"
										variant="ghost"
										disabled={busy !== null}
										onclick={() => void Effect.runPromise(pointLogoAt(null))}
									>
										Remove logo
									</Button>
								{/if}
							</Cluster>
						</Cluster>
					</Stack>

					<Inline justify="end" class="border-t pt-4">
						<Button type="submit" disabled={busy !== null || organizationName.trim() === ''}>
							<Inline as="span" gap="sm" justify="center">
								{#if busy === 'profile'}
									<Icon icon="lucide:loader-2" class="size-4 animate-spin" />
								{/if}
								Save changes
							</Inline>
						</Button>
					</Inline>
				</fieldset>
			</Stack>
		</Stack>
	</Scroll>
</Bound>
