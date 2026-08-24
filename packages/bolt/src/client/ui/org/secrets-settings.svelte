<script lang="ts">
	import { Effect } from 'effect';
	import { Button } from '@norbital-ai/ui/button';
	import { Input } from '@norbital-ai/ui/input';
	import { Bound, Cover, Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import type { EnvironmentVariable } from '#lib/client/ui/studio/studio-state.js';
	import type { WorkspaceClient } from '#lib/client/ui/studio/workspace-client.js';

	/**
	 * The Environment secrets vault, as a form generated from the workspace's `+env.ts`.
	 *
	 * The form is never hand-written: a workspace declares what it needs and this renders exactly
	 * that, so a new variable appears here the moment it is declared and a removed one disappears.
	 *
	 * A secret is write-only. The server reports whether a value is set and never what it is, so a
	 * configured field shows its state and an empty box — there is nothing to prefill it with, and a
	 * masked placeholder would only imply the value had been fetched.
	 *
	 * Every Bolt command derives its subject from the credential and ignores any subject a caller
	 * supplies, so this page has no identity of its own to establish — it only needs the one
	 * connection the session already declares.
	 */
	/**
	 * The transport is the session's, named rather than reached for.
	 *
	 * It used to arrive as a `command` prop the host shell threaded down, which was correct while the
	 * host owned the shell. The workspace client owns it now, and one declared session is what every
	 * surface reads — a second channel handed down beside it would be two ways to say the same thing.
	 */
	let { client }: { client: WorkspaceClient } = $props();

	let drafts = $state<Record<string, string>>({});
	const statusQuery = $derived(client.system.secrets.status({}));
	const entries = $derived<ReadonlyArray<EnvironmentVariable>>(statusQuery.current ?? []);
	const loading = $derived(statusQuery.loading);
	let saveError = $state<string | null>(null);
	const error = $derived(
		saveError ??
			(statusQuery.error === undefined
				? null
				: statusQuery.error instanceof Error
					? statusQuery.error.message
					: 'Unable to read the vault.')
	);
	let saving = $state<string | null>(null);
	let saved = $state<string | null>(null);

	const save = (name: string): Effect.Effect<void> =>
		Effect.suspend(() => {
			saving = name;
			saved = null;
			saveError = null;
			return client.system.secrets.write({ name, value: drafts[name] ?? '' });
		}).pipe(
			Effect.map(() => {
				// The draft is dropped rather than kept: holding a secret in a component's state after it is
				// stored keeps a copy alive in the page for no reason.
				drafts = Object.fromEntries(Object.entries(drafts).filter(([key]) => key !== name));
				saved = name;
			}),
			Effect.catch((cause) => {
				saveError = cause instanceof Error ? cause.message : 'Unable to store the value.';
				return Effect.void;
			}),
			Effect.ensuring(Effect.sync(() => (saving = null)))
		);
</script>

<!--
	The header is pinned and only the declared names scroll. A workspace may declare more variables
	than fit, and the previous `min-h-full` body inside a clipping `Bound` had no scrollport at all —
	every entry past the fold was unreachable rather than merely below it. The header follows the
	product's page-heading rhythm, as Workspace Studio does: title, one line of what the page is for,
	sitting on the background rather than in a card.
-->
<Bound size="full" clip class="bg-background">
	<Cover gap="lg" class="px-4 pt-4 sm:px-6 sm:pt-6">
		{#snippet top()}
			<Stack as="header" gap="xs" shrink={false}>
				<h1 class="text-heading">Environment secrets</h1>
				<p class="max-w-2xl text-meta">
					The values this workspace asked for in <code>+env.ts</code>. Stored in the vault and read
					only by server-side code — a value is never sent back to this page once it is saved.
				</p>
			</Stack>
		{/snippet}
		<Scroll name="Declared environment" layout="stack" gap="lg" class="max-w-3xl pb-4 sm:pb-6">
			{#if loading}
				<p class="text-sm text-muted-foreground">Reading the vault…</p>
			{:else if error}
				<p class="text-sm text-destructive" role="alert">{error}</p>
			{:else if entries.length === 0}
				<section
					class="rounded-lg border border-dashed border-border/70 bg-card/20 p-8 text-center"
					aria-label="No declared environment variables"
				>
					<p class="text-sm text-muted-foreground">
						This workspace has not declared any environment variables. Add a <code>+env.ts</code> at the
						workspace root to ask for one.
					</p>
				</section>
			{:else}
				{#each entries as entry (entry.name)}
					<Stack as="section" gap="xs" class="rounded-lg border border-border/70 bg-card/20 p-4">
						<Stack as="header" gap="xs">
							<Inline gap="sm">
								<h2 class="text-sm font-semibold text-foreground">{entry.label}</h2>
								{#if entry.configured}
									<span class="rounded-sm bg-muted px-1.5 py-0.5 text-meta">Set</span>
								{:else}
									<span class="rounded-sm bg-muted px-1.5 py-0.5 text-meta"> Not set </span>
								{/if}
								{#if !entry.secret}
									<span class="rounded-sm bg-muted px-1.5 py-0.5 text-meta"> Not a secret </span>
								{/if}
							</Inline>
							<code class="text-meta">{entry.name}</code>
							{#if entry.description}
								<p class="text-meta">{entry.description}</p>
							{/if}
							{#if !entry.configured && entry.default}
								<p class="text-meta">
									Falls back to <code>{entry.default}</code> while unset.
								</p>
							{/if}
						</Stack>
						<Inline gap="sm">
							<Input
								class="h-8 min-w-0 flex-1 text-xs"
								type={entry.secret ? 'password' : 'text'}
								autocomplete="off"
								placeholder={entry.configured ? 'Replace the stored value' : 'Enter a value'}
								aria-label={entry.label}
								value={drafts[entry.name] ?? ''}
								oninput={(event) =>
									(drafts = { ...drafts, [entry.name]: event.currentTarget.value })}
							/>
							<Button
								type="button"
								size="sm"
								disabled={saving === entry.name || (drafts[entry.name] ?? '') === ''}
								onclick={() => void Effect.runPromise(save(entry.name))}
							>
								{saving === entry.name ? 'Saving…' : 'Save'}
							</Button>
							{#if entry.configured}
								<Button
									type="button"
									size="sm"
									variant="outline"
									disabled={saving === entry.name}
									onclick={() => {
										drafts = { ...drafts, [entry.name]: '' };
										void Effect.runPromise(save(entry.name));
									}}
								>
									Clear
								</Button>
							{/if}
						</Inline>
						{#if saved === entry.name}
							<p class="text-meta">Stored.</p>
						{/if}
					</Stack>
				{/each}
			{/if}
		</Scroll>
	</Cover>
</Bound>
