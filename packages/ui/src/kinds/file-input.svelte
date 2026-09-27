<!--
@component
A `file` field's input: a drop zone (or click to browse), uploads through the host first (accept and size checked), each
in flight or failed shown as a row, then the stored files as rows with thumbnail, size, download and remove.
-->
<script lang="ts" module>
	import type { Json, KindOf } from './kind.js';

	/** A `file` field: bytes go to the host first (`bolt.upload`, accept and max checked before), the draft holds refs. */
	export type FileInputProps = {
		kind: KindOf<'file'>;
		value: Json;
		onChange(next: Json): void;
		/** The field name the upload is checked against. */
		name: string;
		id?: string;
		disabled?: boolean;
		invalid?: boolean;
	};
</script>

<script lang="ts">
	import Icon from '@iconify/svelte';
	import { cn, uiText } from '../primitives/utils.js';
	import { useKinds } from './context.js';
	import { useForm } from '../form/form-state.svelte.js';
	import FileList, { type PendingFile } from './file-list.svelte';
	import { fileProblem, isFile, MAX_FILES, untag, type FileRef } from './kind.js';

	let { kind, value, onChange, name, id, disabled = false, invalid = false }: FileInputProps = $props();
	const host = useKinds();
	// the upload target is `<collection>.<field>` (§5.7); a submit of the enclosing form waits for it
	const form = useForm();
	const target = $derived(form === undefined ? name : `${form.spec.target.collection}.${name}`);
	const t = uiText();
	const refs = $derived(((v) => (Array.isArray(v) ? v : [v]).filter(isFile))(untag(value)));
	const max = $derived(kind.multiple ? MAX_FILES : 1);
	let pending = $state<PendingFile[]>([]);
	let problems = $state<string[]>([]);
	let over = $state(false), seq = 0;
	const can = $derived(host.upload !== undefined && !disabled);
	const room = $derived(max - refs.length - pending.filter((p) => p.error === undefined).length);

	async function upload(p: PendingFile): Promise<FileRef | null> {
		try {
			const ref = await host.upload!(p.file, target);
			pending = pending.filter((x) => x.key !== p.key);
			return ref;
		} catch (e) {
			pending = pending.map((x) => (x.key === p.key ? { ...x, error: e instanceof Error ? e.message : t('uploadFailed') } : x));
			return null;
		}
	}
	async function add(files: readonly File[]) {
		const take = files.slice(0, Math.max(room, 0));
		problems = take.map((f) => fileProblem(kind, f)).filter((p): p is string => p !== null);
		const batch = take.filter((f) => fileProblem(kind, f) === null).map((file) => ({ key: seq++, file }));
		pending = [...pending, ...batch];
		const done = (await Promise.all(batch.map(upload))).filter((r): r is FileRef => r !== null);
		if (done.length > 0) onChange(kind.multiple ? [...refs, ...done] : done[0]!);
	}
	async function retry(p: PendingFile) {
		pending = pending.map((x) => (x.key === p.key ? { key: x.key, file: x.file } : x));
		const ref = await upload(p);
		if (ref !== null) onChange(kind.multiple ? [...refs, ref] : ref);
	}
	// evaluated before `?.`: a form-less input still uploads
	const run = (work: Promise<void>) => { form?.track(work); };
	const start = (files: readonly File[]) => { if (files.length > 0) run(add(files)); };
	const remove = (ref: FileRef) => onChange(kind.multiple ? refs.filter((r) => r.id !== ref.id) : null);
	const size = $derived(kind.max.replace('iB', 'B'));
	const typeNames: Record<string, string> = {
		'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
		'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX'
	};
	const types = $derived(kind.accept.includes('*/*') ? '' : kind.accept.map((a) =>
		typeNames[a] ?? a.replace(/^[^/]+\/(?!\*)/, '').replace('/*', '').toUpperCase()).join(', '));
</script>

<div class="grid min-w-0 gap-2">
	{#if refs.length > 0 || pending.length > 0}
		<FileList {refs} {pending} onRemove={can ? remove : undefined} onRetry={can ? (p) => run(retry(p)) : undefined} onDismiss={(p) => (pending = pending.filter((x) => x.key !== p.key))} {disabled} />
	{/if}
	{#if can && room > 0}
		<label
			for={id}
			class={cn(
				'grid cursor-pointer place-items-center gap-1 rounded-lg border-2 border-dashed border-border px-3 text-center transition-colors hover:border-brand-400 hover:bg-brand-muted/30',
				refs.length + pending.length > 0 ? 'py-3' : 'py-6',
				over && 'border-brand-400 bg-brand-muted/30',
				invalid && 'border-destructive'
			)}
			ondragover={(e) => { e.preventDefault(); over = true; }}
			ondragleave={() => (over = false)}
			ondrop={(e) => { e.preventDefault(); over = false; start([...(e.dataTransfer?.files ?? [])]); }}
		>
			<Icon icon="lucide:upload" class={cn('text-muted-foreground', refs.length + pending.length > 0 ? 'size-4' : 'size-6')} />
			<span class="text-sm font-medium text-muted-foreground">{kind.multiple ? t('dropFiles') : t('dropFile')}</span>
			<span class="text-meta">
				{[kind.multiple ? t('upToFiles').replace('{n}', String(MAX_FILES)) : '', kind.multiple ? t('sizeEach').replace('{size}', size) : size, types].filter(Boolean).join(' · ')}
			</span>
			<input {id} type="file" class="sr-only" accept={kind.accept.join(',')} multiple={kind.multiple} onchange={(e) => { start([...(e.currentTarget.files ?? [])]); e.currentTarget.value = ''; }} />
		</label>
	{/if}
	{#each problems as p (p)}<p class="text-xs text-destructive">{p}</p>{/each}
</div>
