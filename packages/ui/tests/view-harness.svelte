<script lang="ts" module>
	import type { ComponentProps } from 'svelte';
	import type { KindsHost } from '../src/kinds/context.js';
	import type { ViewBolt } from '../src/client/contract.js';
	import NativeTable, { type TableSource } from '../src/table/Table.svelte';
	const Table = NativeTable<TableSource>;
	export type ViewPart =
		| { part: 'table'; props: ComponentProps<typeof Table> }
		| {
				part: 'matrix';
				props: ComponentProps<typeof Matrix>;
				onTrailing?: () => void;
				onColumn?: (col: import('../src/client/contract.js').Json) => void;
		  }
		| { part: 'board'; props: ComponentProps<typeof Board> }
		| { part: 'record'; props: ComponentProps<typeof RecordShell> }
		| { part: 'point'; props: ComponentProps<typeof PointInput> }
		| { part: 'picker'; props: ComponentProps<typeof Picker> }
		| { part: 'form'; props: ComponentProps<typeof Form> }
		| { part: 'approval'; props: ComponentProps<typeof ApprovalPanel> }
		| { part: 'child'; props: ComponentProps<typeof ChildGrid> }
		| { part: 'childCustom'; props?: Record<string, never> };
	export type ViewHarnessProps = {
		catalog: NonNullable<KindsHost['catalog']>;
		geocoder?: KindsHost['geocoder'];
		upload?: KindsHost['upload'];
		read?: KindsHost['read'];
		zone?: string;
	} & (
		| (Extract<ViewPart, { part: 'point' | 'picker' }> & { bolt?: ViewBolt })
		| (Exclude<ViewPart, { part: 'point' | 'picker' }> & { bolt: ViewBolt })
	);
</script>

<script lang="ts">
	// Mounts a view under a scripted `bolt` and catalog: a Table, a Board, a Form, or a RecordShell inside a Sheet.
	import { Layer, ManagedRuntime } from 'effect';
	import { onDestroy } from 'svelte';
	import { mountEdge } from '../src/effect/index.js';
	import { provideKinds } from '../src/kinds/context.js';
	import PointInput from '../src/kinds/point-input.svelte';
	import Picker from '../src/kinds/picker.svelte';
	import { Sheet } from '../src/primitives/sheet/index.js';
	import { provideBolt } from '../src/client/context.js';
	import { type Page } from '../src/collection/types.js';
	import Board from '../src/board/Board.svelte';
	import Matrix from '../src/matrix/Matrix.svelte';
	import Button from '../src/primitives/button/button.svelte';
	import Icon from '../src/primitives/icon/icon-wrapper.svelte';
	import type { BoardProps } from '../src/board/Board.svelte';
	import Form from '../src/form/form.svelte';
	import RecordShell from '../src/record/RecordShell.svelte';
	import ApprovalPanel from '../src/approval/ApprovalPanel.svelte';
	import ChildGrid from '../src/relations/ChildGrid.svelte';
	import ChildCustom from './child-custom-harness.svelte';

	let fixture: ViewHarnessProps = $props();
	onDestroy(mountEdge(ManagedRuntime.make(Layer.empty)));
	// svelte-ignore state_referenced_locally
	if (fixture.bolt !== undefined) provideBolt(fixture.bolt);
	provideKinds({
		get catalog() {
			return fixture.catalog;
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
		get read() {
			const bolt = fixture.bolt;
			return fixture.read ?? (bolt === undefined ? undefined : (c, o) => bolt.read<Page>(c, o));
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
	<Table
		{...fixture.props}
		{...tableSource === undefined ? {} : { of: tableSource }}
		{...tableColumns === undefined ? {} : { columns: tableColumns }}
		{...tableScope === undefined ? {} : { where: tableScope }}
	/>
{:else if fixture.part === 'board'}
	<Board {...fixture.props} {...boardScope === undefined ? {} : { where: boardScope }} />
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
	<Matrix
		{...fixture.props}
		{...fixture.onColumn === undefined ? {} : { columnHeader }}
		{...fixture.onTrailing === undefined
			? {}
			: { toolbar: { ...(fixture.props.toolbar || {}), trailing } }}
	/>
{:else if fixture.part === 'point'}
	<PointInput {...fixture.props} />
{:else if fixture.part === 'form'}
	<Form {...fixture.props} />
{:else if fixture.part === 'approval'}
	<ApprovalPanel {...fixture.props} />
{:else if fixture.part === 'child'}
	<ChildGrid {...fixture.props} />
{:else if fixture.part === 'childCustom'}
	<ChildCustom />
{:else if fixture.part === 'picker'}
	<Picker {...fixture.props} />
{:else}
	<Sheet open title="jobs"><RecordShell {...fixture.props} /></Sheet>
{/if}
