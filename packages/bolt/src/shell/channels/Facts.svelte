<!--
	What the host published about a channel, as label and copyable value: the webhook URL, a mailbox address, a bot's name.
	The keys are the connection's generic `about` vocabulary, never a provider's; one the shell has no label for shows
	under its own key rather than being dropped.
-->
<script lang="ts">
	import { Input } from '@norbital-ai/ui';
	import type { Json } from '../../decl/values.ts';

	let { facts, t }: { facts: readonly (readonly [string, Json])[]; t: (key: string) => string } = $props();
	const LABELS = $derived<{ readonly [k: string]: string }>({ webhookUrl: t('Webhook URL'), redirectUrl: t('Redirect URI'), address: t('Address'), server: t('Server'), folder: t('Folder'), openTracking: t('Open tracking'), botName: t('Bot'), workspace: t('Workspace'),
		team: t('Team'), guilds: t('Servers'), inviteUrl: t('Invite link'), account: t('Account'), from: t('Sender') });
	const text = (v: Json): string => Array.isArray(v) ? v.map((x) => typeof x === 'object' && x !== null && !Array.isArray(x) && typeof x['name'] === 'string' ? x['name'] : text(x)).join(', ')
		: v === null || typeof v === 'object' ? '' : String(v);
	const rows = $derived(facts.map(([k, v]) => [LABELS[k] ?? k, text(v), k] as const).filter((r) => r[1] !== ''));
</script>

{#if rows.length > 0}
	<dl class="grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2 text-sm">
		{#each rows as [label, value, key] (key)}
			<dt class="text-meta">{label}</dt>
			<dd class="min-w-0" data-fact={key}><Input readonly {value} class={key.endsWith('Url') ? 'font-mono text-xs wrap-anywhere' : 'wrap-anywhere'} /></dd>
		{/each}
	</dl>
{/if}
