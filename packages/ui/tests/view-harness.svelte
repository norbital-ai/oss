<script lang="ts" module>
	// Each fixture passes the view component it mounts (`view`): a file loads only the components it uses.
	import type { ComponentProps } from 'svelte';
	import type { KindsHost } from '../src/kinds/context.js';
	import type { UiContext, ViewBolt } from '../src/client/contract.js';
	import type NativeTable from '../src/table/Table.svelte';
	import type { TableSource } from '../src/table/Table.svelte';
	import type Board from '../src/board/Board.svelte';
	import type RecordShell from '../src/record/RecordShell.svelte';
	import type PointInput from '../src/kinds/point-input.svelte';
	import type Picker from '../src/kinds/picker.svelte';
	import type Form from '../src/form/form.svelte';
	import type ApprovalPanel from '../src/approval/ApprovalPanel.svelte';
	import type ChildGrid from '../src/relations/ChildGrid.svelte';
	import type BulkRelation from '../src/model/BulkRelation.svelte';
	import type Map from '../src/map/Map.svelte';
	type Table = typeof NativeTable<TableSource>;
	export type ViewPart =
		| { part: 'table'; view: Table; props: Omit<ComponentProps<Table>, 'ctx'> }
		| { part: 'board'; view: typeof Board; props: Omit<ComponentProps<typeof Board>, 'ctx'> }
		| { part: 'record'; view: typeof RecordShell; props: Omit<ComponentProps<typeof RecordShell>, 'ctx'> }
		| { part: 'point'; view: typeof PointInput; props: Omit<ComponentProps<typeof PointInput>, 'ctx'> }
		| { part: 'picker'; view: typeof Picker; props: Omit<ComponentProps<typeof Picker>, 'ctx'> }
		| { part: 'form'; view: typeof Form; props: Omit<ComponentProps<typeof Form>, 'ctx'> }
		| { part: 'approval'; view: typeof ApprovalPanel; props: Omit<ComponentProps<typeof ApprovalPanel>, 'ctx'> }
		| { part: 'child'; view: typeof ChildGrid; props: Omit<ComponentProps<typeof ChildGrid>, 'ctx'> }
		| { part: 'bulk-relation'; view: typeof BulkRelation; props: Omit<ComponentProps<typeof BulkRelation>, 'ctx'> }
		| { part: 'map'; view: typeof Map; props: Omit<ComponentProps<typeof Map>, 'ctx'> };
	export type ViewHarnessProps = {
		catalog: NonNullable<KindsHost['catalog']>;
		automations?: KindsHost['automations'];
		geocoder?: KindsHost['geocoder'];
		upload?: KindsHost['upload'];
		query?: KindsHost['query'];
		zone?: string;
		/** Mounts the view inside a readonly form's controls (a viewed record). */
		readonly?: boolean;
	} & (
		| (Extract<ViewPart, { part: 'point' | 'picker' }> & { bolt?: ViewBolt })
		| (Exclude<ViewPart, { part: 'point' | 'picker' }> & { bolt: ViewBolt })
	);
</script>

<script lang="ts">
	// Mounts the fixture's view under a scripted `bolt` and catalog; a RecordShell inside a Sheet.
	import { Layer, ManagedRuntime } from 'effect';
	import { onDestroy } from 'svelte';
	import { mount_edge } from '../src/effect/index.js';
	import { provideControls } from '../src/primitives/utils.js';
	import Sheet from '../src/primitives/sheet/sheet.svelte';
	import type { BoardProps } from '../src/board/Board.svelte';

	let fixture: ViewHarnessProps = $props();
	onDestroy(mount_edge(ManagedRuntime.make(Layer.empty)));
	provideControls(() => ({ readonly: fixture.readonly }));
	// svelte-ignore state_referenced_locally
	const client = fixture.bolt;
	const ctx: UiContext = { ui: { bolt: client, kinds: {
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
	} } };
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
		{ctx}
		{...fixture.props}
		{...tableSource === undefined ? {} : { of: tableSource }}
		{...tableColumns === undefined ? {} : { columns: tableColumns }}
		{...tableScope === undefined ? {} : { where: tableScope }}
	/>
{:else if fixture.part === 'board'}
	<fixture.view {ctx} {...fixture.props} {...boardScope === undefined ? {} : { where: boardScope }} />
{:else if fixture.part === 'record'}
	<Sheet open><fixture.view {ctx} {...fixture.props} /></Sheet>
{:else if fixture.part === 'point'}
	<fixture.view {ctx} {...fixture.props} />
{:else if fixture.part === 'picker'}
	<fixture.view {ctx} {...fixture.props} />
{:else if fixture.part === 'form'}
	<fixture.view {ctx} {...fixture.props} />
{:else if fixture.part === 'approval'}
	<fixture.view {ctx} {...fixture.props} />
{:else if fixture.part === 'bulk-relation'}
	<fixture.view {ctx} {...fixture.props} />
{:else if fixture.part === 'map'}
	<fixture.view {ctx} {...fixture.props} />
{:else}
	<fixture.view {ctx} {...fixture.props} />
{/if}
