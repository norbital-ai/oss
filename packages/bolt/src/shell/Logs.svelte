<!--
	The workspace log (§5.12, administrators): `sys_event` in ui's `LogView`, one dense monospace line per event (time ·
	level · event and attributes), oldest at the top. The view filters by level and text, follows the tail and renders
	only the rows in view; this page loads older pages by cursor and polls the tail.
-->
<script lang="ts">
	import { onDestroy } from 'svelte';
	import { Stack } from '@norbital-ai/ui/layout';
	import { LogView } from '@norbital-ai/ui';
	import type { LogRow } from './data.ts';
	import type { ShellApi } from './runtime.ts';

	let { api, t }: { api: ShellApi; t: (key: string) => string } = $props();

	const PAGE = 200;
	let lines = $state<LogRow[]>([]);
	let follow = $state(true);
	let older = $state(true);
	let error = $state<string | null>(null);
	let busy = false;

	async function page(cursor: { before?: string; after?: string }): Promise<LogRow[] | null> {
		busy = true;
		const r = await api.logs(cursor);
		busy = false;
		if (!r.ok) return (error = r.error.message), null;
		error = null;
		return r.value.reverse();
	}
	/** One page before the oldest line (the newest page when empty). */
	async function loadOlder(): Promise<void> {
		if (busy || !older) return;
		const before = lines[0]?.id;
		const rows = await page(before === undefined ? {} : { before });
		if (rows === null) return;
		older = rows.length === PAGE;
		lines = [...rows, ...lines];
	}
	/** New lines after the newest one, while following. */
	async function tail(): Promise<void> {
		if (busy || !follow) return;
		const after = lines.at(-1)?.id;
		if (after === undefined) return loadOlder();
		const rows = await page({ after });
		if (rows !== null && rows.length > 0) lines = [...lines, ...rows];
	}
	void loadOlder();
	const timer = setInterval(() => void tail(), 2_000);
	onDestroy(() => clearInterval(timer));

	const detail = (r: LogRow) => {
		const a = r.attributes === null || typeof r.attributes !== 'object' ? '' : Object.entries(r.attributes).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ');
		return [r.event, r.run === null ? '' : `run=${r.run}`, r.conversation === null ? '' : `conversation=${r.conversation}`, a].filter((x) => x !== '').join(' ');
	};
	const rows = $derived(lines.map((r) => ({ id: r.id, at: r.at, level: r.severity, message: detail(r) })));
</script>

<Stack gap="sm" fill class="min-h-0 p-6">
	<h1 class="text-lg font-semibold">{t('Logs')}</h1>
	{#if error !== null}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
	<LogView {rows} bind:follow loadOlder={() => loadOlder()} hasOlder={older} class="min-h-0 flex-1" />
</Stack>
