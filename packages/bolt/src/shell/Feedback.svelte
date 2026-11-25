<!--
	The Feedback dialog (the account menu's, on a host that takes feedback): a person's words and images for the
	workspace's administrators, and under them what that person sent before with what became of each. Images go up as
	panel attachments when it is sent; the host gets their stored references.
-->
<script lang="ts">
	import { fork, observe_once } from '@norbital-ai/ui/effect';
	import { Effect } from 'effect';
	import type { SentFeedback } from '@norbital-ai/host-api';
	import { Badge, Button, Dialog, Icon, Spinner, Textarea, toast } from '@norbital-ai/ui';
	import { Inline, Stack } from '@norbital-ai/ui/layout';
	import type { ShellApi } from './api-types.ts';
	import Attachments from './agent/Attachments.svelte';

	let {
		api,
		t,
		route,
		on_close
	}: {
		/** What the dialog calls: the panel's upload for its images, then the send. */
		api: Pick<ShellApi, 'feedback' | 'feedback_sent'> & { agent: Pick<ShellApi['agent'], 'upload'> };
		t: (key: string) => string;
		/** The open page's route pattern (`route_pattern`). */
		route: string;
		on_close: () => void;
	} = $props();

	const STATUS: { readonly [status in SentFeedback['status']]: string } = {
		received: 'Received',
		working: 'Being worked on',
		done: 'Done',
		closed: 'Closed',
		platform: 'Passed to the platform'
	};
	const sent = observe_once(() => api.feedback_sent());
	const day = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
	let text = $state('');
	let images = $state<File[]>([]);
	let sending = $state(false);
	let error = $state<string | null>(null);
	let picker = $state<HTMLInputElement | null>(null);
	const send = Effect.fn('Feedback.send')(function* () {
		sending = true;
		error = null;
		const sent = yield* Effect.result(
			Effect.forEach(images, (image) => api.agent.upload(image)).pipe(
				Effect.flatMap((files) => api.feedback(text, files, route))
			)
		);
		sending = false;
		if (sent._tag === 'Failure') return void (error = t(sent.failure.message));
		toast.success(t('Feedback sent'));
		on_close();
	});
</script>

<Dialog.Root
	open
	on_open_change={(open) => {
		if (!open) on_close();
	}}
>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<Dialog.Title>{t('Feedback')}</Dialog.Title>
			<Dialog.Description>
				{t("What you send goes to your workspace's administrators.")}<br />
				{t('They read it, and an assistant may help prepare a fix.')}
			</Dialog.Description>
		</Dialog.Header>
		<form
			onsubmit={(event) => {
				event.preventDefault();
				fork(send());
			}}
		>
			<Stack gap="md">
				<Textarea
					rows={5}
					aria-label={t('Feedback')}
					placeholder={t('What happened, or what would be better?')}
					bind:value={text}
				/>
				{#if images.length > 0}
					<Attachments
						files={images}
						file_href={() => ''}
						{t}
						on_remove={(file) => (images = images.filter((image) => image !== file))}
					/>
				{/if}
				<input
					bind:this={picker}
					type="file"
					multiple
					accept="image/*"
					class="sr-only"
					aria-hidden="true"
					tabindex="-1"
					onchange={(event) => {
						images = [
							...images,
							...[...(event.currentTarget.files ?? [])].filter((file) => file.type.startsWith('image/'))
						];
						event.currentTarget.value = '';
					}}
				/>
				<Inline>
					<Button type="button" variant="outline" onclick={() => picker?.click()}>
						<Icon name="lucide:image-plus" class="size-4" />{t('Add images')}
					</Button>
				</Inline>
				{#if error !== null}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
				<Dialog.Footer>
					<Button type="submit" disabled={sending || (text.trim() === '' && images.length === 0)}>
						{#if sending}<Spinner class="size-3.5" />{/if}{t('Send')}
					</Button>
				</Dialog.Footer>
			</Stack>
		</form>
		{#if (sent.current?.length ?? 0) > 0}
			<section aria-label={t('What you sent')} class="max-h-64 overflow-y-auto border-t pt-4">
				<Stack gap="md">
					<h3 class="text-sm font-medium">{t('What you sent')}</h3>
					{#each sent.current ?? [] as one (one.id)}
						<Stack gap="xs">
							<Inline justify="between" gap="sm">
								<span class="text-xs text-muted-foreground">{day.format(new Date(one.at))}</span>
								<Badge variant={one.status === 'done' ? 'brand' : 'outline'}>{t(STATUS[one.status])}</Badge>
							</Inline>
							<p class="line-clamp-2 text-sm">{one.text}</p>
							{#if one.reply !== null}
								<p class="text-sm text-muted-foreground">
									<span class="font-medium">{t(one.reply.by === 'assistant' ? 'Assistant' : 'Administrator')}:</span>
									{one.reply.text}
								</p>
							{/if}
						</Stack>
					{/each}
				</Stack>
			</section>
		{/if}
	</Dialog.Content>
</Dialog.Root>
