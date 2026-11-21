<!--
	What a tool step shows when opened: each tool in its own terms, never an input and an output side by side. A read is its
	table under a toolbar of its conditions, a source edit its diff, the browser its address and page, a search its results,
	a check its verdicts, a script its code and what it returned. A tool with no view of its own shows its data.
-->
<script lang="ts">
	import { Option, Schema } from 'effect';
	import {
		Badge,
		CodeDiff,
		CodeEditor,
		Icon,
		StructuredData,
		type UiContext
	} from '@norbital-ai/ui';
	import type { AgentRow } from '../../protocol/wire.ts';
	import ReadTable from './ReadTable.svelte';
	import ActInput from './ActInput.svelte';
	import { languageOf, readChips, readsOf, stepArgs, type StepView } from './view.ts';

	let {
		ctx,
		tool,
		view,
		t
	}: { ctx: UiContext; tool: NonNullable<AgentRow['tool']>; view: StepView; t: (key: string) => string } = $props();

	type Obj = Readonly<Record<string, unknown>>;
	const object = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
	const list = (v: unknown): readonly Obj[] => (Array.isArray(v) ? v.filter(object) : []);
	const text = (v: unknown) => (typeof v === 'string' ? v : '');
	const parse = (raw: string | undefined) =>
		Option.getOrNull(Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))(raw ?? ''));

	const args = $derived(stepArgs(tool.args)),
		input = $derived(object(args) ? args : {}),
		data = $derived(parse(tool.result)),
		out = $derived<Obj>(object(data) ? data : {}),
		json = (v: unknown) => Schema.decodeUnknownSync(Schema.Json)(v);
	/** A clipped result does not parse: its escapes undone, it reads as written. */
	const raw = $derived((tool.result ?? '').replaceAll('\\n', '\n').replaceAll('\\"', '"'));
	const verdict = (ok: boolean) => (ok ? 'lucide:circle-check' : 'lucide:circle-alert');
	const issues = (types: unknown) => list(object(types) ? types['diagnostics'] : []);
	const SOURCE = new Set(['describe_workspace', 'skill']);
	/** A compact diff's two sides: kept and `-` lines before, kept and `+` lines after; an `@@` line stands in both. */
	const sides = (diff: string) => {
		const before: string[] = [],
			after: string[] = [];
		for (const line of diff.split('\n')) {
			const mark = line[0],
				body = mark === '@' ? line : line.slice(1);
			if (mark !== '+') before.push(body);
			if (mark !== '-') after.push(body);
		}
		return { before: before.join('\n'), after: after.join('\n') };
	};
</script>

{#snippet code(value: string, language: 'javascript' | 'json' | 'plaintext' = 'plaintext')}
	<div class="max-h-56 overflow-auto rounded-md border text-micro" data-step-pane="code">
		<CodeEditor
			{value}
			{language}
			readonly
			wrap
			min_height="0"
			aria-label={t('Code')}
		/>
	</div>
{/snippet}
{#snippet data_(value: unknown, name: string)}
	<div class="max-h-56 overflow-auto rounded-md border" data-step-pane="data">
		<StructuredData {ctx} value={json(value)} {name} frame={false} />
	</div>
{/snippet}
{#snippet address(url: string)}
	<div
		class="flex min-w-0 items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1"
		data-address
	>
		<Icon name="lucide:globe" class="size-3 shrink-0 text-muted-foreground" />
		<a href={url} target="_blank" rel="noreferrer" class="min-w-0 truncate font-mono text-micro"
			>{url}</a
		>
	</div>
{/snippet}

{#if tool.changes !== undefined && tool.changes.length > 0}
	<div class="grid max-h-72 gap-1 overflow-auto" data-step-pane="diff">
		{#each tool.changes as file, index (index)}
			{@const { before, after } = sides(file.diff)}
			<CodeDiff path={file.path} {before} {after} language={languageOf(file.path)} />
		{/each}
	</div>
{:else if tool.name === 'read'}
	{@const rows = object(data) && 'result' in data ? data['result'] : data}
	<div class="grid gap-1" data-tool-view="read">
		{#each readsOf(input) as [key, layer] (key)}
			{@const chips = readChips(layer)}
			{#if chips.length > 0}
				<div class="flex flex-wrap items-center gap-1" data-read-toolbar={key}>
					{#if !key.includes('.') && readsOf(input).length > 1}
						<span class="font-mono text-micro text-muted-foreground">{key}</span>
					{/if}
					{#each chips as chip (chip)}<Badge variant="outline" class="font-mono">{chip}</Badge
						>{/each}
				</div>
			{/if}
		{/each}
		<div class="max-h-72 overflow-auto rounded-md"><ReadTable {ctx} value={rows} {t} /></div>
	</div>
{:else if tool.name === 'act'}
	{@const acts = object(input['acts']) ? input['acts'] : {}}
	{@const outcome = text(out['kind']) || (out['run'] !== undefined ? 'started' : '')}
	<div class="grid gap-1" data-tool-view="act">
		{#if outcome !== ''}
			<div class="flex items-center gap-1.5">
				<Badge variant={outcome === 'committed' || outcome === 'started' ? 'default' : 'outline'}
					>{t(outcome === 'pending_approval' ? 'Waiting for approval' : outcome)}</Badge
				>
				<span class="font-mono text-micro text-muted-foreground"
					>{Object.keys(acts).join(', ')}</span
				>
			</div>
		{/if}
		<ActInput {ctx} input={json(input)} {t} />
	</div>
{:else if tool.name === 'browser'}
	{@const url = text(out['url']) || text(input['url'])}
	{@const steps = list(input['steps'])}
	{@const opened = object(out['page']) ? out['page'] : out}
	<div class="grid gap-1" data-tool-view="browser">
		{#if url !== ''}{@render address(url)}{/if}
		{#if steps.length > 0}
			<ol class="grid gap-0.5 text-micro text-muted-foreground">
				{#each steps as step, index (index)}
					{@const [verb, target] = Object.entries(step)[0] ?? ['', '']}
					<li class="truncate">
						{index + 1}. {verb}
						{typeof target === 'string' ? target : JSON.stringify(target)}
					</li>
				{/each}
			</ol>
		{/if}
		{#if text(input['evaluate']) !== ''}{@render code(text(input['evaluate']), 'javascript')}{/if}
		{#if out['value'] !== undefined}
			{@render data_(out['value'], t('Output'))}
		{:else if text(opened['page']) !== ''}
			{@render code(text(opened['page']))}
		{:else if text(out['saved']) !== ''}
			<p class="text-micro">{text(out['saved'])}</p>
		{/if}
	</div>
{:else if tool.behavior.web_results === true}
	<ul class="grid max-h-72 gap-2 overflow-auto" data-tool-view="web_results">
		{#each list(out['results']) as hit (text(hit['url']))}
			<li class="min-w-0">
				<a
					href={text(hit['url'])}
					target="_blank"
					rel="noreferrer"
					class="block truncate font-medium hover:underline"
					>{text(hit['title']) || text(hit['url'])}</a
				>
				<p class="truncate text-micro text-muted-foreground">
					{[text(hit['site']), text(hit['date'])].filter((x) => x !== '').join(' · ')}
				</p>
				<p class="line-clamp-2 text-micro">{text(hit['excerpt'])}</p>
			</li>
		{/each}
	</ul>
{:else if tool.name === 'run_js'}
	<div class="grid gap-1" data-tool-view="run_js">
		{#if view.code !== undefined && view.code.text !== ''}
			{@render code(view.code.text, view.code.language)}
		{/if}
		{#if out['answer'] !== undefined && out['answer'] !== null}
			{@render data_(out['answer'], t('Output'))}
		{/if}
		{#if Array.isArray(out['console']) || text(out['console']) !== ''}
			{@render code(
				Array.isArray(out['console']) ? out['console'].join('\n') : text(out['console'])
			)}
		{/if}
	</div>
{:else if tool.behavior.diagnostics === true}
	{@const types = out['types']}
	{@const tests = object(out['tests']) ? out['tests'] : null}
	<!-- the step's line already says what the check found: the body shows only where, one compact line each -->
	<div class="grid gap-1.5" data-tool-view="validate">
		{#if text(out['preview']) !== ''}{@render address(text(out['preview']))}{/if}
		{#if tests !== null}
			<p class="flex items-center gap-1.5 text-micro">
				<Icon name={verdict(text(tests['state']) === 'passed')} class="size-3.5 shrink-0" />{t(
					'Tests'
				)}
				{text(tests['state'])}
			</p>
		{/if}
		{#if issues(types).length > 0}
			<ul class="grid max-h-56 gap-1 overflow-auto text-micro" data-tool-view="diagnostics">
				{#each issues(types) as issue, index (index)}
					<li class="grid min-w-0 gap-0.5" title={text(issue['message'])}>
						<span class="flex min-w-0 gap-1.5 font-mono text-muted-foreground"
							><span class="min-w-0 truncate"
								>{text(issue['path'])}{typeof issue['line'] === 'number'
									? `:${issue['line']}`
									: ''}</span
							><span class="shrink-0">{text(issue['code'])}</span></span
						>
						<span class="line-clamp-2 break-words text-foreground/90">{text(issue['message'])}</span
						>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
{:else if tool.name === 'read_file' && Array.isArray(out['lines'])}
	<div class="grid gap-1" data-tool-view="read_file">
		{#if text(out['at']) !== ''}<p class="text-micro text-muted-foreground">
				{text(out['at'])}
			</p>{/if}
		{@render code(out['lines'].join('\n'))}
	</div>
{:else if SOURCE.has(tool.name)}
	{@render code(
		text(out['body']) ||
			text(out['text']) ||
			(Array.isArray(out['lines']) ? out['lines'].join('\n') : '') ||
			(typeof data === 'string' ? data : raw),
		text(input['path']).match(/\.(m?[jt]sx?|svelte)$/) === null ? 'plaintext' : 'javascript'
	)}
{:else if tool.name === 'workspace_read' && typeof data === 'string'}
	<!-- OpenCode's read: what it read and which lines, then the lines -->
	{@const [range = '', ...lines] = data.split('\n')}
	<div class="grid gap-1" data-tool-view="workspace_read">
		<p class="truncate font-mono text-micro text-muted-foreground">{range}</p>
		{#if lines.length > 0}{@render code(lines.join('\n'), languageOf(text(input['path'])))}{/if}
	</div>
{:else if ['workspace_list_dir', 'workspace_grep', 'workspace_glob'].includes(tool.name)}
	<pre class="max-h-96 overflow-auto font-mono text-micro" data-step-pane="tree">{tool.result}</pre>
{:else if tool.studio === 'logs'}
	{@const lines = list(out['records'])}
	<ul class="grid max-h-56 gap-0.5 overflow-auto font-mono text-micro" data-tool-view="logs">
		{#each lines as line, index (index)}
			<li class="truncate">
				{text(line['at']).slice(11, 19)}
				{text(line['level'])}
				{text(line['message'])}
			</li>
		{/each}
	</ul>
{:else if tool.name === 'read_file' && typeof out['attached'] === 'string' && Object.keys(out).every((k) => k === 'attached' || k === 'page' || k === 'image' || k === 'crops')}
	<p class="px-1 text-micro text-muted-foreground" data-tool-view="image">
		{typeof out['page'] === 'number'
			? `${t('Page')} ${out['page']}`
			: typeof out['image'] === 'number'
				? `${t('Image')} ${out['image']}`
				: t('Viewed image')}
	</p>
{:else if data !== null}
	{@render data_(data, t('Output'))}
{:else if tool.result !== undefined && tool.result !== ''}
	{@render code(raw)}
{/if}
