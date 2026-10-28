<script lang="ts" module>
	// Each fixture passes the view component it mounts (`view`): a file loads only the components it uses.
	import type { ComponentProps } from 'svelte';
	import type { KindsHost } from '../src/kinds/context.js';
	import type { ViewBolt } from '../src/client/contract.js';
	import type NativeTable from '../src/table/Table.svelte';
	import type { TableSource } from '../src/table/Table.svelte';
	import type Board from '../src/board/Board.svelte';
	import type Matrix from '../src/matrix/Matrix.svelte';
	import type RecordShell from '../src/record/RecordShell.svelte';
	import type PointInput from '../src/kinds/point-input.svelte';
	import type Picker from '../src/kinds/picker.svelte';
	import type Form from '../src/form/form.svelte';
	import type ApprovalPanel from '../src/approval/ApprovalPanel.svelte';
	import type ChildGrid from '../src/relations/ChildGrid.svelte';
	type Table = typeof NativeTable<TableSource>;
	export type ViewPart =
		| { part: 'table'; view: Table; props: ComponentProps<Table> }
		| {
				part: 'matrix';
				view: typeof Matrix;
				props: ComponentProps<typeof Matrix>;
				onTrailing?: () => void;
				onColumn?: (col: import('../src/client/contract.js').Json) => void;
		  }
		| { part: 'board'; view: typeof Board; props: ComponentProps<typeof Board> }
		| { part: 'record'; view: typeof RecordShell; props: ComponentProps<typeof RecordShell> }
		| { part: 'point'; view: typeof PointInput; props: ComponentProps<typeof PointInput> }
		| { part: 'picker'; view: typeof Picker; props: ComponentProps<typeof Picker> }
		| { part: 'form'; view: typeof Form; props: ComponentProps<typeof Form> }
		| { part: 'approval'; view: typeof ApprovalPanel; props: ComponentProps<typeof ApprovalPanel> }
		| { part: 'child'; view: typeof ChildGrid; props: ComponentProps<typeof ChildGrid> };
	export type ViewHarnessProps = {
		catalog: NonNullable<KindsHost['catalog']>;
		automations?: KindsHost['automations'];
		geocoder?: KindsHost['geocoder'];
		upload?: KindsHost['upload'];
		query?: KindsHost['query'];
		zone?: string;
	} & (
		| (Extract<ViewPart, { part: 'point' | 'picker' }> & { bolt?: ViewBolt })
		| (Exclude<ViewPart, { part: 'point' | 'picker' }> & { bolt: ViewBolt })
	);
</script>

<script lang="ts">
	// Mounts the fixture's view under a scripted `bolt` and catalog; a RecordShell inside a Sheet.
	import { Layer, ManagedRuntime } from 'effect';
	import { onDestroy } from 'svelte';
	import { mountEdge } from '../src/effect/index.js';
	import { provideKinds } from '../src/kinds/context.js';
	import Sheet from '../src/primitives/sheet/sheet.svelte';
	import { provideBolt } from '../src/client/context.js';
	import Button from '../src/primitives/button/button.svelte';
	import Icon from '../src/primitives/icon/icon-wrapper.svelte';
	import type { BoardProps } from '../src/board/Board.svelte';

	let fixture: ViewHarnessProps = $props();
	onDestroy(mountEdge(ManagedRuntime.make(Layer.empty)));
	// svelte-ignore state_referenced_locally
	if (fixture.bolt !== undefined) provideBolt(fixture.bolt);
	provideKinds({
		get catalog() {
			return fixture.catalog;
		},
		get automations() {
			return fixture.automations;
		},
		get geocoder() {
			return fixture.geocoder;
		},
		get zone() {
			return fixture.zone;
		},
		get upload() {
			return fixture.upload;
		},
		get query() {
			const bolt = fixture.bolt;
			return fixture.query ?? (bolt === undefined ? undefined : (request) => bolt.query(request));
		}
	});
	let boardScope = $state<BoardProps['where']>(undefined);
	export function setBoardScope(where: BoardProps['where']) {
		boardScope = where;
	}
	let tableScope = $state<BoardProps['where']>(undefined);
	export function setTableScope(where: BoardProps['where']) {
		tableScope = where;
	}
	let tableSource = $state<string | undefined>(undefined);
	export function setTableSource(of: string) {
		tableSource = of;
	}
	let tableColumns = $state<readonly string[] | undefined>(undefined);
	export function setTableColumns(columns: readonly string[]) {
		tableColumns = columns;
	}
</script>

{#if fixture.part === 'table'}
	<fixture.view
		{...fixture.props}
		{...tableSource === undefined ? {} : { of: tableSource }}
		{...tableColumns === undefined ? {} : { columns: tableColumns }}
		{...tableScope === undefined ? {} : { where: tableScope }}
	/>
{:else if fixture.part === 'board'}
	<fixture.view {...fixture.props} {...boardScope === undefined ? {} : { where: boardScope }} />
{:else if fixture.part === 'matrix'}
	{#snippet trailing()}
		<Button
			variant="ghost"
			size="icon-sm"
			aria-label="Schedule details"
			onclick={fixture.onTrailing}><Icon name="lucide:info" /></Button
		>
	{/snippet}
	{#snippet columnHeader({
		col,
		label
	}: {
		col: import('../src/client/contract.js').Json;
		label: string;
	})}
		<Button variant="ghost" size="sm" onclick={() => fixture.onColumn?.(col)}>{label}</Button>
	{/snippet}
	<fixture.view
		{...fixture.props}
		{...fixture.onColumn === undefined ? {} : { columnHeader }}
		{...fixture.onTrailing === undefined
			? {}
			: { toolbar: { ...(fixture.props.toolbar || {}), trailing } }}
	/>
{:else if fixture.part === 'record'}
	<Sheet open title="jobs"><fixture.view {...fixture.props} /></Sheet>
{:else if fixture.part === 'point'}
	<fixture.view {...fixture.props} />
{:else if fixture.part === 'picker'}
	<fixture.view {...fixture.props} />
{:else if fixture.part === 'form'}
	<fixture.view {...fixture.props} />
{:else if fixture.part === 'approval'}
	<fixture.view {...fixture.props} />
{:else}
	<fixture.view {...fixture.props} />
{/if}
