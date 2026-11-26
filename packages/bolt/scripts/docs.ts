/// <reference types="node" />
// The API reference generator, run by bolt's build after the package compiles: `node scripts/docs.ts`.
// It walks every public entry (`exports`, `./tooling` aside) of bolt, host-api, ui and bolt-cli, reads each entry's
// declarations with the TypeScript checker (no TypeDoc) and writes one JSON document per namespace plus `index.json`
// to `build/docs/`, where `@norbital-ai/bolt/docs` reads them. bolt and its dependencies are read from their built
// `.d.ts`; bolt-cli builds after bolt, so its entries are read from source, and its `bolt` command's verbs become the
// `bolt-cli/cli` namespace (each `Command.make` const's doc comment, its flags' and arguments' descriptions).
// Output is sorted and carries no time, so a build of the same sources is byte-identical. Svelte components are read
// through svelte-package's `.svelte.d.ts`: their props are the second parameter of the component's call signature,
// and a prop of an object type lists its fields. Each symbol carries its `group`, the source folder it lives in under
// the entry. `index.json`'s `missing` lists every symbol and component prop without a doc comment; `tests/docs.test.ts`
// fails on it.
// `oss/skills/` (the one source of authoring skills, which realm agents read by path) compiles beside it:
// one `skill.<name>.json` per skill folder holding every Markdown file, listed in `index.json`'s `skills`.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { Effect, Schema } from 'effect';
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import { skill_file } from '../src/engine/docs-corpus.ts';
import type {
	DocIndex,
	DocKind,
	DocMember,
	DocNamespace,
	DocParam,
	DocSkill,
	DocSymbol
} from '../src/engine/docs-corpus.ts';

class DocsFailed extends Schema.TaggedError<DocsFailed>()('DocsFailed', {
	message: Schema.String,
	cause: Schema.Defect()
}) {}

const PACKAGES = ['bolt', 'host-api', 'ui', 'bolt-cli'];
/** Packages read from source: they build after bolt. */
const FROM_SOURCE = new Set(['bolt-cli']);
/** What an author reads for each role: these symbols' shapes, generated into `bolt-contract` so a card cannot drift. */
const CONTRACT: { readonly [role: string]: { readonly [namespace: string]: readonly string[] } } = {
	model: {
		bolt: ['model', 'ModelLiteral', 'CreateInput', 'UpdateInput', 'WriteCtx', 'CarriedWrites', 'Kind']
	},
	access: { bolt: ['policy', 'StoredTree', 'ApprovalFlow', 'Verdict'] },
	automation: {
		bolt: ['automation', 'AutomationCtx', 'EffectCtx', 'Notice', 'Notify', 'Recipient', 'ApprovalRecipient'],
		'bolt/errors': ['Refusal']
	},
	sync: { bolt: ['sync', 'SyncCtx', 'SyncRow', 'Finding'] },
	integration: {
		bolt: ['integration', 'IntegrationLiteral', 'Integration', 'InstanceId', 'instance_id', 'is_instance'],
		'bolt/page': ['IntegrationSetup']
	},
	page: {
		bolt: ['app', 'group'],
		'bolt/page': ['PageBolt', 'PageSnapshotHost'],
		ui: ['Table', 'Col', 'Form', 'Field', 'Section', 'RecordShell', 'Board', 'Chart', 'Surface']
	},
	behaviors: {
		ui: ['Surface'],
		'ui/behaviors': [
			'create_disclosure',
			'create_accordion',
			'create_selection',
			'create_roving_focus',
			'create_focus_recovery',
			'create_typeahead',
			'create_listbox',
			'create_async_options',
			'create_menu',
			'create_tree',
			'tree_from_paths',
			'tree_checked_states',
			'toggle_tree_checked',
			'create_grid_focus',
			'create_cell_range',
			'create_inline_edit',
			'cell_bounds',
			'cells_to_text',
			'text_to_cells',
			'create_overflow',
			'create_reorder',
			'move_item',
			'bind_drag',
			'DRAG_THRESHOLD',
			'create_auto_scroll',
			'create_transfer',
			'create_tree_reorder',
			'subtree_end',
			'create_resize',
			'create_resize_box',
			'create_slider',
			'create_dismiss',
			'inert_outside',
			'lock_scroll',
			'announce',
			'prepare_announcements',
			'set_announcer',
			'create_presence',
			'bind_findable',
			'supports_hidden_until_found',
			'create_hover_intent',
			'bridge_between',
			'reset_hover_group',
			'create_focus_trap',
			'tabbable_elements',
			'create_shortcuts',
			'matches_shortcut',
			'aria_keyshortcuts',
			'format_shortcut',
			'create_stick_to_bottom',
			'create_pagination',
			'page_range',
			'create_clipboard',
			'create_field',
			'create_floating',
			'portal',
			'set_portal_target',
			'get_portal_target',
			'create_pin_input',
			'create_date_field',
			'create_time_field',
			'create_calendar',
			'create_input_history',
			'create_undo_stack',
			'bind_hold',
			'bind_repeat',
			'input_hints',
			'nearest_in_direction',
			'spatial_move',
			'create_move',
			'create_area',
			'create_spans',
			'is_span_free',
			'stack_spans',
			'create_lasso',
			'create_viewport',
			'create_connect',
			'create_swipe_actions',
			'bind_scroll_picker',
			'create_switch',
			'create_radio_group',
			'create_toggle_group',
			'create_number_input',
			'create_rating',
			'create_toolbar',
			'watch',
			'watch_pre',
			'Debounced',
			'use_debounce',
			'PersistedState',
			'register_control',
			'page_controls',
			'resolve_control',
			'invoke_control',
			'act_on_control',
			'describe_controls',
			'observe_controls',
			'notify_control_change',
			'create_ui_history',
			'with_source',
			'current_source',
			'fuzzy_score',
			'match_ranges',
			'match_segments',
			'bind_viewport',
			'bind_avoid_keyboard',
			'pointer_kind_of',
			'create_pointer_kind',
			'color_scheme_of',
			'create_color_scheme',
			'color_scheme_script',
			'is_focus_from_keyboard',
			'current_modality',
			'keep_focus',
			'bind_drag_preview',
			'create_preview',
			'settle_draft',
			'create_cookie_storage',
			'create_overlay_stack',
			'rubber_band',
			'create_velocity_tracker',
			'nearest_snap_point',
			'step_spring',
			'create_drawer',
			'create_token_input',
			'create_trigger_menu',
			'create_checkbox_group',
			'create_file_dropzone',
			'create_password_input',
			'create_panel_group',
			'create_carousel',
			'create_menubar',
			'create_navigation_menu',
			'create_hover_card',
			'parse_color',
			'format_color',
			'rgb_to_hsl',
			'hsl_to_rgb',
			'rgb_to_hsv',
			'hsv_to_rgb',
			'contrast_ratio',
			'mix_colors',
			'create_color_picker',
			'create_image_cropper',
			'create_waterfall',
			'create_timeline',
			'check_pattern',
			'check_direction',
			'virtual_list'
		]
	},
	representation: {
		'bolt/page': ['PageBolt', 'PageContext'],
		ui: ['RecordShell', 'RecordView', 'Form', 'Field', 'Section', 'Table', 'Col']
	},
	test: {
		'bolt-cli/test': [
			'TestWorkspace', 'Kit', 'Caller', 'TestOptions', 'JobResult', 'NativeReadRow', 'NativeReadAnswer', 'NativeActAnswer'
		]
	}
};
/** Each role's first file, appended to the primer so one read starts a build; the cards hold only the symbols' shapes. */
const CONTRACT_HEAD: { readonly [role: string]: string } = {
	automation: `An automation runs under its declared \`policies\`. They must read every model it reads or links to, \`sys_user\` included:

\`\`\`ts
// src/automation/+<name>.automation.ts
import { automation, new_id, type CreateInput, type UpdateInput } from '@norbital-ai/bolt';

export default automation({
	description: '<what it does>',
	on: [{ cron: '0 2 * * *' }], // integrations own webhooks; row writes run their model's effect
	policies: ['<policy>'],
	run: function* (input, ctx) {
		const { rows } = (yield* ctx.query({ <model>: { fields: ['id', 'revision', '<field>'] } })).<model>;
		const id = new_id('<model>');
		const creates: CreateInput<'<model>'>[] = [{ <field>: <value> }];
		const updates: { target: (typeof rows)[number]; set: UpdateInput<'<model>'> }[] = rows.map((row) => ({
			target: row, // pass the read row directly (carries branded id + revision)
			set: { <field>: <value> }
		}));
		yield* ctx.act({
			...(creates.length > 0 ? { '<model>.create': creates.map((c, i) => (i === 0 ? { id, ...c } : c)) } : {}),
			...(updates.length > 0 ? { '<model>.update': updates } : {})
		});
	}
});
\`\`\`

The default mode is a durable job. \`mode: 'call'\` returns its typed \`output\` in the request; a positive \`cache\` duration shares read-only answers. The agent starts it only after the person confirms each start; \`agent: 'never'\` keeps it from the agent. Jobs alone accept cron triggers and retries.

A model answers \`yield* ctx.ai.sys_2.infer({ system: '<role>', prompt: '<task>', output: { kind: 'object', fields: { <field>: { kind: 'text' } } } })\` with the \`output\`'s value (text when absent).

Runtime accounts are durable \`sys_integration\` rows, created in Settings or through \`sys_integration.create\`; source declares no connection slots. \`yield* ctx.notify({ title: '<title>', to: [{ policy: '<policy>' }], via: [instance_id('<integration>', account)] })\` reaches each recipient in the app and on the selected account. Built-in conversation definitions need no duplicate source declaration.

For a daily channel message, read the intended active workspace account (\`owner\` null, with its intended \`envoy\`) and use \`yield* ctx.send(instance_id('whatsapp', account), { to: '<recipient handle or conversation id>', text: '<message>' })\` in the cron body. Import \`instance_id\` from \`@norbital-ai/bolt\`. Refuse when the account is missing or ambiguous; never silently choose another account. Sends are durably queued, and the provider's acknowledgement and retry outcome appear on the message. Retries of an automation may repeat committed sends: do not promise exactly-once delivery. The recipient's later replies use that account's envoy and the same conversation, with delivered messages in context.

Time is \`ctx.today\`, a \`PlainDate\`, and \`ctx.now\`, an ISO instant string; do date and duration math with Effect's \`DateTime\` and \`Duration\` (\`DateTime.add(DateTime.makeUnsafe(ctx.today), { months: 1 })\`, \`DateTime.formatIsoDateUtc\`). A model's \`effect\` has the same two.

In a test, \`t.clock.set('<instant>')\` then \`const { failed } = yield* t.run_due()\` fires what is due at that instant. Assert \`expect(failed).toEqual([])\` first: a run that failed says why there, and nothing else will.`,
	model: `\`src/data/model/<name>/+model.ts\`. A model takes only the writes it declares (\`delete: {}\` must be declared here before any policy can grant \`delete\`):

\`\`\`ts
import { model } from '@norbital-ai/bolt';

export default model('<name>', {
	description: '<what one record is>',
	icon: 'lucide:<icon>',
	record_label: 'record.<field>', // row's own text/computed field — never a ref FK
	fields: {
		<field>: { kind: 'text' },
		<other>: { kind: 'ref', to: '<model>', inverse: '<field on it>', on_delete: 'restrict' }
	},
	outputs: { default: { fields: 'all' } },
	// write trees mirror outputs: { fields: [...], <child_relation>: { fields: [...] } } (never nest create/update/delete inside a child relation)
	create: { fields: ['<field>', '<other>'], <lines>: { fields: ['<child_field>'] } },
	update: { fields: ['<field>', '<other>'], <lines>: { fields: ['<child_field>'] } },
	delete: {}
});
\`\`\`

\`seq\` patterns take one \`{0…}\` counter and only \`{yyyy}\`, \`{yy}\`, \`{mm}\`. \`decimal\`/\`money\` fields write and read as exact decimal strings (\`'10.00'\`), never JS numbers. A required field added to a model with rows needs a data step in its generated migration, filling them.`,
	integration: `A definition lives at \`src/integration/<name>/+integration.ts\` and declares \`integration('<name>', { … })\` (\`<name>\` is its folder). Read the definition's exported types before authoring it. Built-in conversation definitions already exist.

Accounts and envoys are runtime records: \`sys_envoy\` holds the assistant's name, task and policies; \`sys_integration\` holds one account, its configuration, optional envoy and durable sealed pairing. Create any number of workspace accounts with no owner. Settings → Envoys creates an envoy then pairs its provider; Settings → Connections creates and configures other workspace accounts. Keep a supplied \`+integration.svelte\` companion.

For native setup in a root web conversation, read \`describe_workspace { names: ['system'] }\`; use the returned capability and account id with \`page { path, configure }\`. The native form collects credentials directly from the person. Envoys and delegated agents have no user tab. Never ask for a secret in chat or invent an envoy source file. Cron jobs send through a concrete paired workspace account with \`ctx.send\`; see the automation card.`,
	access: `A policy is one file; a grant names only verbs its model declares (never grant \`delete\` unless the model declares \`delete: {}\`). State transitions use \`update: { moves: 'all' }\` or \`moves: { <state_field>: ['<from>-><to>'] }\`. Teams are \`sys_team\` rows an administrator edits (a name, an optional parent and the policies its members hold); source declares none and holds a team only as an id read from a row. A policy file:

\`\`\`ts
// src/access_control/policy/+<policy>.policy.ts
import { policy } from '@norbital-ai/bolt';

export default policy({
	description: '<what holders may do>',
	grants: { <model>: { outputs: { default: {} }, create: {}, update: { moves: 'all' } } }
});
\`\`\``,
	page: `An app is its folder: \`+app.ts\` and one \`+<page>.page.svelte\` per page. Use message keys in \`+app.ts\` (\`title\`, \`description\`, \`pages.<page>.title\`) declared in \`src/i18n/+messages.ts\` (and \`+<lang>.messages.ts\` for extra languages). Always pass \`{ctx}\` to \`<Table>\`, \`<Board>\` and \`<RecordShell>\`:

\`\`\`ts
// src/app/<app>/+app.ts
import { app } from '@norbital-ai/bolt';

export default app({
	title: 'app.<app>.title',
	description: 'app.<app>.description',
	icon: 'lucide:<icon>',
	pages: { <page>: { title: 'app.<app>.tab_<page>', icon: 'lucide:<icon>' } }
});
\`\`\`

\`\`\`svelte
<!-- src/app/<app>/+<page>.page.svelte -->
<script lang="ts">
	import { Table } from '@norbital-ai/ui';
	let { ctx } = $props();
</script>

<Table {ctx} of="<model>" />
\`\`\`

Common UI props (host renders \`AppShell\` automatically — pages never import it):
- \`<Table {ctx} of="<model>" where? order_by? columns? actions? toolbar? empty? on_open? />\` — \`actions\` takes \`RowAction<R>[]\` (\`{ label, confirm?, run(row) }\`, where \`run\` returns an \`Effect\` or \`void\`).
- \`<Board {ctx} of="<model>" by="<state_field>" card={['<f1>', '<f2>']} lanes? where? order_by? toolbar? on_open? />\` — \`card\` is a tuple of ≤4 field names or a snippet \`[{ row }]\`.
- \`<RecordShell {ctx} of="<model>" mode={view.mode} {...record === null ? {} : { id: record.id }}>\` wrapping \`<Form {ctx} of="<model>" ...>\` with \`<Section icon="lucide:<icon>" title="...">\`, \`<Field {ctx} name="..." />\`, and child \`<Table {ctx} of="<child>" where={{ <parent>: { eq: record.id } }} />\` (see the representation starter below).
- \`<Button variant? size? onclick? disabled?>\`, \`<Badge>\`, \`<StateBadge>\`, \`<Tabs tabs={[{ name, title, body }]} bind:value />\`, \`<Sheet bind:open title="..." side? />\`, \`<Dialog.Root>\`, \`<Popover.Root>\`, \`<Tooltip>\`, \`<Combobox>\`, \`<Accordion.Root>\`, \`<EmptyState>\`.
- **Novel / custom interactive UIs:** wrap panels in \`<Surface tone="card|subtle|muted|lane" padding="sm|md" radius="control">\` with \`@norbital-ai/ui/layout\` (\`Stack\`, \`Inline\`, \`Grid\`, \`Cluster\`, \`Bound\`) and semantic tokens (\`surface-*\`, \`content-*\`, \`border-*\`, \`tone-*\`; zero \`dark:\` overrides or raw palette colors). **Never hand-roll UI behaviors** — compose custom interactive widgets from \`@norbital-ai/ui/behaviors\` (read \`skill { name: 'bolt-contract', file: 'behaviors.md' }\` and \`authoring-tenant-workspace\` \`references/behaviors-and-composition.md\`) and register every custom control with \`register_control\` so Norbius can observe and operate it.
- Live page reads & RPCs: \`const q = ctx.query({ <model>: { fields: [...], where?, order_by?, limit? } })\` — read \`q.current?.<model>.rows ?? []\`, \`q.loading\`, \`q.error\`; start automations with \`ctx.run('<automation>', input)\`.`
	,
	behaviors: `**Never hand-roll UI behaviors in tenant pages.** Compose custom interactive widgets directly from \`@norbital-ai/ui/behaviors\` (the same Svelte-5 headless primitives powering \`@norbital-ai/ui\`) paired with \`<Surface>\`, \`@norbital-ai/ui/layout\`, and \`@norbital-ai/ui\` primitives. Never install external UI/utility libraries (\`bits-ui\`, \`runed\`) or hand-roll keyboard arrow/Escape loops, outside-click listeners, focus traps, drag/reorder/resize handles, sliders, menus, trees, grids, radio/switch/toggle/checkbox groups, token/trigger/dropzone/password/color inputs, inline edit, pagination, clipboard, stick-to-bottom, debounce timers, or raw \`localStorage\` reads/writes. For standard popovers, modals, drawers, and tooltips, prefer \`<Popover.Root>\`, \`<Dialog.Root>\`, \`<Sheet>\`, and \`<Tooltip>\` directly; for full-height split-pane workbenches, size the outer grid with \`h-full min-h-0 overflow-hidden\` (each pane \`min-h-0 overflow-y-auto\`) rather than guessing \`calc(100dvh - ...)\`. Read exact signatures anytime with \`skill { name: 'bolt-contract', file: 'behaviors.md' }\`.

- **Navigation, search, menus & trees:** \`create_tree\` (\`tree_from_paths\`, \`tree_checked_states\`, \`toggle_tree_checked\`), \`create_listbox\` (DOM or \`aria-activedescendant\` virtual focus), \`fuzzy_score\` / \`match_ranges\` / \`match_segments\`, \`create_async_options\`, \`create_menu\` (\`role="menu"\` + context menu), \`create_menubar\`, \`create_navigation_menu\`, \`create_hover_card\`, \`create_roving_focus\`, \`create_toolbar\`, \`create_typeahead\`, \`create_overflow\`, \`virtual_list\`, \`create_pagination\` (\`page_range\`), \`create_carousel\`.
- **Grids, selection, drag, motion & direct manipulation:** \`create_selection\`, \`create_grid_focus\`, \`create_cell_range\` (\`cells_to_text\`/\`text_to_cells\`), \`create_inline_edit\`, \`bind_drag\`, \`bind_drag_preview\`, \`create_auto_scroll\`, \`create_reorder\` (\`move_item\`), \`create_transfer\`, \`create_tree_reorder\`, \`create_resize\`, \`create_resize_box\`, \`create_panel_group\`, \`create_slider\` (range/vertical/RTL), \`create_drawer\` (\`rubber_band\`, \`create_velocity_tracker\`, \`nearest_snap_point\`, \`step_spring\`), plus spatial/canvas primitives (\`create_move\`, \`create_area\`, \`create_spans\`, \`create_lasso\`, \`create_viewport\`, \`create_connect\`, \`create_swipe_actions\`, \`bind_scroll_picker\`, \`create_timeline\`, \`create_waterfall\`, \`create_image_cropper\`).
- **Overlays, focus, platform & accessibility:** \`create_floating\` (virtual cursor anchors + available bounds), \`create_dismiss\`, \`create_overlay_stack\`, \`create_focus_trap\` (\`modal\`, \`prevent_scroll\`), \`inert_outside\`, \`lock_scroll\`, \`create_focus_recovery\`, \`keep_focus\`, \`announce\`, \`create_hover_intent\` (\`bridge_between\`), \`create_presence\`, \`bind_findable\`, \`portal\`, \`create_disclosure\`, \`create_accordion\`, \`bind_viewport\`, \`bind_avoid_keyboard\`, \`create_pointer_kind\`, \`create_color_scheme\`, \`is_focus_from_keyboard\`, \`check_pattern\`, \`check_direction\`.
- **Controls, inputs, color, shortcuts & micro-behaviors:** \`create_switch\`, \`create_radio_group\`, \`create_toggle_group\`, \`create_checkbox_group\`, \`create_number_input\`, \`create_rating\`, \`create_field\`, \`create_token_input\`, \`create_trigger_menu\`, \`create_file_dropzone\`, \`create_password_input\`, \`create_pin_input\`, \`create_date_field\`, \`create_time_field\`, \`create_calendar\`, \`create_color_picker\` (\`parse_color\`, \`format_color\`, \`contrast_ratio\`, \`mix_colors\`), \`create_shortcuts\` (chords like \`'g i'\`, \`matches_shortcut\`, \`aria_keyshortcuts\`, \`format_shortcut\`), \`create_clipboard\`, \`create_stick_to_bottom\`, \`create_input_history\`, \`create_undo_stack\`, \`create_preview\`, \`settle_draft\`, \`bind_hold\`, \`bind_repeat\`, \`input_hints\`, \`nearest_in_direction\`, \`spatial_move\`.
- **Reactive helpers & agent observability:** \`watch\` / \`watch.pre\`, \`Debounced\`, \`use_debounce\`, \`PersistedState\`, \`create_cookie_storage\`, \`register_control\` (required on every custom stateful widget), \`page_controls\`, \`invoke_control\`, \`observe_controls\`, \`create_ui_history\`, plus DOM marks \`data-agent-confirm\`, \`data-agent-secret\`, \`data-agent-hidden\`.

\`\`\`svelte
<script lang="ts">
	import { Badge, Button, Surface } from '@norbital-ai/ui';
	import {
		PersistedState,
		create_inline_edit,
		create_menu,
		create_radio_group,
		create_reorder,
		create_resize,
		create_selection,
		create_shortcuts,
		create_slider,
		create_tree,
		register_control
	} from '@norbital-ai/ui/behaviors';
	import { Inline, Stack } from '@norbital-ai/ui/layout';
</script>
\`\`\``,
	representation: `A model's custom record screen lives beside its model at \`src/data/model/<model>/+representation.svelte\`. The shell passes \`{ view, ctx }\` (\`RecordView<'<model>'>\` and \`PageContext\`) — **never** \`id\`. Derive \`record = view.mode === 'create' ? null : view.record\`, omit \`id\` when creating (passing \`id: undefined\` fails with \`ReadFailed\`), pass \`{ctx}\` to every \`<Field>\`, always give every \`<Section>\` an appropriate \`icon\`, and guard child \`<Table>\`s with \`{#if record}\`:

\`\`\`svelte
<!-- src/data/model/<model>/+representation.svelte -->
<script lang="ts">
	import type { PageContext } from '@norbital-ai/bolt/page';
	import { Field, Form, RecordShell, Section, Table, open_record, type RecordView } from '@norbital-ai/ui';
	import { Grid } from '@norbital-ai/ui/layout';

	let { view, ctx }: { view: RecordView<'<model>'>; ctx: PageContext } = $props();
	const record = $derived(view.mode === 'create' ? null : view.record);
</script>

<RecordShell
	{ctx}
	of="<model>"
	mode={view.mode}
	{...record === null ? { values: view.mode === 'create' ? view.values : {} } : { id: record.id }}
>
	<Form
		{ctx}
		of="<model>"
		mode={view.mode === 'create' ? 'create' : 'update'}
		{...record === null
			? { values: view.mode === 'create' ? view.values : {} }
			: { id: record.id, record }}
		on_outcome={(outcome) => {
			if (view.mode === 'create' && outcome.kind === 'committed' && outcome.records[0] !== undefined)
				open_record('<model>', outcome.records[0].id);
		}}
	>
		{#snippet children()}
			<Section icon="lucide:file-text" first name="details" title={ctx.t('section.details')}>
				<Grid minimum="compact">
					<Field {ctx} name="<field>" />
				</Grid>
			</Section>
			{#if record}
				<Section icon="lucide:list" name="lines" title={ctx.t('section.lines')}>
					<Table {ctx} of="<child>" where={{ <parent>: { eq: record.id } }} />
				</Section>
			{/if}
		{/snippet}
	</Form>
</RecordShell>
\`\`\``,
	test: `Tests are \`tests/<name>.test.ts\`. Everything comes from the kit, and \`workspace_test\` runs them (Vitest does **not** type-check tests — always run \`workspace_diagnose {}\` after editing any test file before committing or merging).
- \`caller.act(...)\` returns \`{ kind: 'committed', records: [{ model, id, revision }] }\` (or \`'held'\`), NOT a per-verb map.
- Brand a record id for \`ref\` fields or \`target\` with \`Schema.decodeUnknownSync(id_of('<model>'))(record.id)\` from \`@norbital-ai/bolt\`.
- \`caller.query(...)\` returns \`Record<string, QueryPage | AggregateResult>\`; narrow each root inline with \`page !== undefined && 'rows' in page ? page.rows : []\` (never cast or write an unnarrowed \`rowsOf\` helper).
- \`caller.run('<automation>', input, JobResult)\` starts an automation; call \`yield* t.run_due()\` to drain queued runs.

\`\`\`ts
import { Effect, Exit, Schema } from 'effect';
import { id_of } from '@norbital-ai/bolt';
import { JobResult, TestWorkspace, expect, it } from '@norbital-ai/bolt-cli/test';

it.layer(TestWorkspace.layer({ root: new URL('..', import.meta.url).pathname }))('<model>', (it) => {
	it.effect('<what it proves>', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			const caller = yield* t.as(t.member(['<policy>'])); // or yield* t.as(t.admin)
			const res = yield* caller.act({ '<model>.create': [{ <field>: <value> }] });
			if (res.kind !== 'committed') throw new Error(res.kind);
			const created = res.records.find((r) => r.model === '<model>');
			if (created === undefined) throw new Error('Expected created record.');
			const id = Schema.decodeUnknownSync(id_of('<model>'))(created.id);
			const refused = yield* Effect.exit(caller.act({ '<model>.create': [{ <field>: <bad value> }] }));
			expect(Exit.isFailure(refused)).toBe(true);
			const page = (yield* caller.query({ <model>: { fields: ['<field>'] } }))['<model>'];
			const rows = page !== undefined && 'rows' in page ? page.rows : [];
			expect(rows.length).toBeGreaterThanOrEqual(1);
			yield* caller.act({
				'<model>.update': [{ target: { id, revision: created.revision }, set: { <field>: <value> } }]
			});
			yield* caller.run('<automation>', {}, JobResult);
			yield* t.run_due();
		})
	);
});
\`\`\`

A file shares one workspace: rows stay between its tests, so assert on your own rows.`
};
const CONTRACT_SKILL = 'bolt-contract';
const PRIMER_SKILL = 'bolt-primer';
const CARDED = new Set(Object.values(CONTRACT).flatMap((named) => Object.values(named).flat()));
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..'); // oss/packages
const out = join(root, 'bolt', 'build', 'docs');
const SKILLS = join(root, '..', 'skills'); // oss/skills: the authoring skills
const CLI = join(root, 'bolt-cli', 'src', 'cli');
const posix = (p: string) => p.split(sep).join('/');
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
/** Code-unit order: the same on every machine, whatever its locale. */
const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

type Entry = { namespace: string; module: string; file: string };
export const generateDocs = Effect.try({
	try: () => {
		const entries: Entry[] = PACKAGES.flatMap((pkg) => {
			const manifest = Schema.decodeUnknownSync(
				Schema.fromJsonString(
					Schema.Struct({
						exports: Schema.Record(
							Schema.String,
							Schema.Union([
								Schema.String,
								Schema.Struct({ types: Schema.optionalKey(Schema.String) })
							])
						)
					})
				)
			)(readFileSync(join(root, pkg, 'package.json'), 'utf8'));
			return Object.entries(manifest.exports).flatMap(([key, target]) => {
				const types = typeof target === 'string' ? undefined : target.types;
				if (
					types === undefined ||
					!types.endsWith('.d.ts') ||
					key.includes('*') ||
					key.startsWith('./tooling')
				)
					return [];
				return [
					{
						namespace: key === '.' ? pkg : `${pkg}/${key.slice(2)}`,
						module: `@norbital-ai/${pkg}${key.slice(1)}`,
						file: join(
							root,
							pkg,
							FROM_SOURCE.has(pkg)
								? types.replace(/^\.\/build\//, 'src/').replace(/\.d\.ts$/, '.ts')
								: types
						)
					}
				];
			});
		}).sort((a, b) => byCode(a.namespace, b.namespace));

		const program = ts.createProgram(entries.map((e) => e.file), {
			noEmit: true,
			skipLibCheck: true,
			strict: true,
			target: ts.ScriptTarget.ESNext,
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			allowArbitraryExtensions: true,
			allowImportingTsExtensions: true,
			types: []
		});
		const checker = program.getTypeChecker();
		const FORMAT =
			ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;

		/** Declared in a first-party package, not a dependency (a prop spread from `HTMLAttributes` is not ours to list). */
		const ours = (d: ts.Declaration) => !d.getSourceFile().fileName.includes('/node_modules/');

		/** `packages/ui/build/chart/Chart.svelte.d.ts` → `packages/ui/src/chart/Chart.svelte:<line>`. */
		function sourceOf(d: ts.Declaration, name: string): string {
			const built = posix(relative(root, d.getSourceFile().fileName));
			const base = built.replace('/build/', '/src/').replace(/\.d\.ts$/, '');
			const file = [`${base}.ts`, base, `${base}.js`].find((f) => existsSync(join(root, f)));
			if (file === undefined) return `packages/${built}`;
			const lines = readFileSync(join(root, file), 'utf8').split('\n');
			const at = lines.findIndex((l) =>
				new RegExp(
					`\\b(function|const|let|type|interface|class|enum|namespace)\\s+${name}\\b`
				).test(l)
			);
			return `packages/${file}:${at + 1 || 1}`;
		}

		/** The comment of a symbol, else of the alias that re-exported it. */
		function comment(sym: ts.Symbol, alias: ts.Symbol): { text: string; examples: string[] } {
			// `/** … */ export * as Dialog from …`: the comment sits on the export statement
			const ns = alias.declarations?.find(ts.isNamespaceExport);
			const nsText =
				ns === undefined
					? ''
					: ts
							.getJSDocCommentsAndTags(ns.parent)
							.filter(ts.isJSDoc)
							.map((d) => ts.getTextOfJSDocComment(d.comment) ?? '')
							.join('\n');
			const exportText =
				alias.declarations
					?.flatMap((declaration) => {
						if (!ts.isExportSpecifier(declaration)) return [];
						return ts
							.getJSDocCommentsAndTags(declaration.parent.parent)
							.filter(ts.isJSDoc)
							.map((doc) => ts.getTextOfJSDocComment(doc.comment) ?? '');
					})
					.join('\n') ?? '';
			const text =
				ts.displayPartsToString(sym.getDocumentationComment(checker)).trim() ||
				ts.displayPartsToString(alias.getDocumentationComment(checker)).trim() ||
				nsText.trim() ||
				exportText.trim();
			const tags = [
				...sym.getJsDocTags(checker),
				...(sym === alias ? [] : alias.getJsDocTags(checker))
			];
			const examples = tags
				.filter((t) => t.name === 'example')
				.map((t) => ts.displayPartsToString(t.text).trim())
				.filter(Boolean);
			const guidance = [
				...new Set(
					tags
						.filter((tag) => !['param', 'example'].includes(tag.name))
						.map((tag) => `@${tag.name} ${ts.displayPartsToString(tag.text).trim()}`)
				)
			];
			return {
				text: [text, ...guidance].filter(Boolean).join('\n\n'),
				examples: [...new Set(examples)]
			};
		}
		const first = (text: string) =>
			(text.split(/\n\s*\n/)[0] ?? '').replace(/\s*\n\s*/g, ' ').trim();

		function typeText(s: ts.Symbol, at: ts.Node): string {
			const d = s.valueDeclaration ?? s.declarations?.[0];
			const node =
				d !== undefined &&
				(ts.isPropertySignature(d) || ts.isParameter(d) || ts.isPropertyDeclaration(d))
					? d.type
					: undefined;
			return clip(
				node !== undefined
					? node.getText().replace(/\s+/g, ' ')
					: checker.typeToString(checker.getTypeOfSymbolAtLocation(s, at), at, FORMAT),
				400
			);
		}

		const isObjectLike = (t: ts.Type) =>
			!!(t.flags & ts.TypeFlags.Object) ||
			(t.isIntersection() && t.types.every((x) => !!(x.flags & ts.TypeFlags.Object)));
		/** The first-party properties of a type, with their docs; at most 80. `expand`: an object-typed one lists its fields. */
		function membersOf(type: ts.Type, at: ts.Node, expand = false): DocParam[] {
			return checker
				.getPropertiesOfType(type)
				.filter(
					(p) =>
						(p.declarations ?? []).some(ours) &&
						!p.name.startsWith('__') &&
						!p.name.startsWith('$$')
				)
				.slice(0, 80)
				.map((p) => {
					const { text, examples } = comment(p, p);
					const summary = first(text);
					// a prop of one object shape (`false | { … }` included) lists that shape's fields
					const own = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(p, at));
					const shapes = (own.isUnion() ? own.types : [own]).filter(
						(t) => isObjectLike(t) && checker.getSignaturesOfType(t, ts.SignatureKind.Call).length === 0
					);
					const shape = shapes.length === 1 ? shapes[0] : undefined;
					const fields = expand && shape !== undefined ? membersOf(shape, at) : [];
					return {
						name: p.name,
						type: typeText(p, at),
						...(p.flags & ts.SymbolFlags.Optional ? { optional: true as const } : {}),
						...(summary === '' ? {} : { summary }),
						...(text.replace(/\s+/g, ' ').trim() === summary ? {} : { docs: text }),
						...(examples.length === 0 ? {} : { examples }),
						...(fields.length === 0 ? {} : { fields })
					};
				});
		}

		function paramsOf(sig: ts.Signature, at: ts.Node): DocParam[] {
			const tags = new Map(
				sig
					.getJsDocTags()
					.filter((t) => t.name === 'param')
					.map((t) => {
						const text = ts.displayPartsToString(t.text).trim();
						const m = /^(\S+)\s*(?:-\s*)?([\s\S]*)$/.exec(text);
						return [m?.[1] ?? '', first(m?.[2] ?? '')] as const;
					})
			);
			return sig.getParameters().map((p) => {
				const declaration = p.valueDeclaration;
				const d =
					declaration !== undefined && ts.isParameter(declaration) ? declaration : undefined;
				// a declaration function's `spec: S & Checked<Base, S, …>` lists its constraint's fields: `Base` is the option shape
				const declared = checker.getTypeOfSymbolAtLocation(p, at);
				const tp = (declared.isIntersection() ? declared.types : [declared]).find(
					(x) => !!(x.flags & ts.TypeFlags.TypeParameter)
				);
				const type =
					tp === undefined ? declared : (checker.getBaseConstraintOfType(tp) ?? declared);
				const fields =
					isObjectLike(type) &&
					checker.getSignaturesOfType(type, ts.SignatureKind.Call).length === 0
						? membersOf(type, at)
						: [];
				const summary = tags.get(p.name) ?? '';
				return {
					name: p.name,
					type: typeText(p, at),
					...(d?.questionToken !== undefined || d?.initializer !== undefined
						? { optional: true as const }
						: {}),
					...(summary === '' ? {} : { summary }),
					...(fields.length === 0 ? {} : { fields })
				};
			});
		}

		/** svelte-package's component shape: `(internal, props)`, with or without a constructor beside it. */
		function componentProps(type: ts.Type): ts.Type | undefined {
			const sig = checker.getSignaturesOfType(type, ts.SignatureKind.Call)[0];
			const ps = sig?.getParameters() ?? [];
			const first = ps[0],
				props = ps[1];
			return ps.length === 2 &&
				first !== undefined &&
				props !== undefined &&
				/^internals?$/.test(first.name)
				? checker.getTypeOfSymbol(props)
				: undefined;
		}

		function declarationText(d: ts.Declaration, name: string): string {
			const text = d.getText().replace(/^\s*(export\s+)?(declare\s+)?/, '');
			return clip(text, CARDED.has(name) ? 4000 : 1500);
		}

		/** Whether any hop of the re-export chain is `export type`. */
		function typeOnly(exported: ts.Symbol): boolean {
			for (
				let s: ts.Symbol | undefined = exported;
				s !== undefined && s.flags & ts.SymbolFlags.Alias;
				s = checker.getImmediateAliasedSymbol(s)
			)
				if ((s.declarations ?? []).some((d) => ts.isTypeOnlyImportOrExportDeclaration(d)))
					return true;
			return false;
		}

		function symbolOf(exported: ts.Symbol): DocSymbol | null {
			const sym =
				exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
			const d = sym.valueDeclaration ?? sym.declarations?.[0];
			if (d === undefined) return null;
			const name = exported.name;
			// `export type { PlainDate }` of a function-and-type pair documents the type
			const f = typeOnly(exported)
				? sym.flags & ~(ts.SymbolFlags.Function | ts.SymbolFlags.Variable)
				: sym.flags;
			const { text, examples } = comment(sym, exported);
			let kind: DocKind,
				signature: string,
				params: DocParam[] | undefined,
				props: DocParam[] | undefined,
				members: DocMember[] | undefined;
			if (f & (ts.SymbolFlags.Function | ts.SymbolFlags.Variable)) {
				const type = checker.getTypeOfSymbolAtLocation(sym, d);
				const propsType = componentProps(type);
				const sigs = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
				if (propsType !== undefined) {
					kind = 'component';
					props = membersOf(propsType, d, true);
					signature = `component ${name}(props: ${clip(checker.typeToString(propsType, d, FORMAT), 600)})`;
				} else if (
					sigs[0] !== undefined &&
					checker.getPropertiesOfType(type).filter((p) => (p.declarations ?? []).some(ours))
						.length === 0
				) {
					kind = 'function';
					signature = sigs
						.map((s) => `function ${name}${checker.signatureToString(s, d, FORMAT)}`)
						.join('\n');
					params = paramsOf(sigs[0], d);
				} else {
					kind = 'const';
					signature = `const ${name}: ${clip(checker.typeToString(type, d, FORMAT), 600)}`;
					const m = membersOf(type, d);
					if (m.length > 0) members = m;
				}
			} else if (f & ts.SymbolFlags.Class) {
				kind = 'class';
				signature = declarationText(d, name);
				const key = checker.getTypeOfSymbolAtLocation(sym, d);
				const service =
					key.getProperty('~effect/Context/Service') === undefined
						? undefined
						: key.getProperty('Service');
				// Effect keys carry their implementation on the static Service type,
				// not the class instance. Authors need that shape to supply a test layer.
				members = membersOf(
					service === undefined
						? checker.getDeclaredTypeOfSymbol(sym)
						: checker.getTypeOfSymbolAtLocation(service, d),
					d
				);
			} else if (f & ts.SymbolFlags.Interface) {
				kind = 'interface';
				signature = declarationText(d, name);
				const type = checker.getDeclaredTypeOfSymbol(sym);
				members = membersOf(type, d);
				const call = checker.getSignaturesOfType(type, ts.SignatureKind.Call)[0];
				if (call !== undefined) params = paramsOf(call, d);
			} else if (f & ts.SymbolFlags.TypeAlias) {
				kind = 'type';
				signature = declarationText(d, name);
				const t = checker.getDeclaredTypeOfSymbol(sym);
				if (isObjectLike(t) && !(ts.isTypeAliasDeclaration(d) && ts.isMappedTypeNode(d.type))) {
					const m = membersOf(t, d);
					if (m.length > 0) members = m;
				}
			} else if (f & ts.SymbolFlags.Enum) {
				kind = 'enum';
				signature = declarationText(d, name);
			} else {
				kind = 'namespace';
				signature = `namespace ${name}`;
			}
			const summary = first(text);
			return {
				name,
				kind,
				signature,
				summary,
				...(text.replace(/\s+/g, ' ').trim() !== summary ? { docs: text } : {}),
				...(params === undefined || params.length === 0 ? {} : { params }),
				...(props === undefined ? {} : { props }),
				...(members === undefined ? {} : { members }),
				...(examples.length === 0 ? {} : { examples }),
				source: sourceOf(d, name)
			};
		}

		/** The entry source's leading comment: what the entry is for (`// @norbital-ai/ui: …`). */
		function entrySummary(e: Entry): string {
			const src = e.file.replace(`${sep}build${sep}`, `${sep}src${sep}`).replace(/\.d\.ts$/, '.ts');
			if (!existsSync(src)) return '';
			const lines: string[] = [];
			for (const l of readFileSync(src, 'utf8').split('\n')) {
				if (l.startsWith('///')) continue;
				const m = /^\s*(?:\/\/|\/\*\*?|\*\/?)\s?(.*)$/.exec(l);
				if (m === null) break;
				if (/^(hook:|ponytail:)/.test((m[1] ?? '').trim())) break;
				lines.push((m[1] ?? '').replace(/\*\/\s*$/, '').trim());
			}
			return lines.join(' ').replace(/\s+/g, ' ').trim();
		}

		/** Each symbol's `group`: its source folder under the entry, past the folders all its symbols share. */
		function grouped(symbols: DocSymbol[]): DocSymbol[] {
			const paths = symbols.map((s) => {
				const file = s.source.replace(/:\d+$/, '');
				const vendor = [...file.matchAll(/\/node_modules\/((?:@[^/]+\/)?[^/]+)\//g)].pop()?.[1];
				return vendor !== undefined
					? null
					: file
							.replace(/^packages\/[^/]+\/(src\/)?/, '')
							.replace(/(\.svelte)?\.(ts|js)$|\.svelte$/, '')
							.split('/');
			});
			const own = paths.filter((p): p is string[] => p !== null);
			let shared = 0;
			while (
				own.length > 0 &&
				own.every((p) => shared < p.length - 1 && p[shared] === own[0]?.[shared])
			)
				shared++;
			return symbols.map((s, i) => ({
				...s,
				group:
					paths[i]?.[shared] ??
					[...s.source.matchAll(/\/node_modules\/((?:@[^/]+\/)?[^/]+)\//g)].pop()?.[1] ??
					''
			}));
		}

		/**
		 * The `bolt` command's verbs, read from bolt-cli's source: each `const x = Command.make('verb', { …config }, …)`
		 * with the doc comment above it, its flags and arguments (`Flag.String('name')`, `Argument.String('name')`, through
		 * a local const or helper) with their `withDescription` text, and its parents through `Command.withSubcommands`.
		 */
		function cliNamespace(): DocNamespace {
			type Verb = { file: string; name: string; at: ts.VariableDeclaration; make: ts.CallExpression };
			const files = readdirSync(CLI)
				.filter((f) => f.endsWith('.ts'))
				.sort(byCode)
				.map((f) => ts.createSourceFile(join(CLI, f), readFileSync(join(CLI, f), 'utf8'), ts.ScriptTarget.ESNext, true));
			const consts = new Map<string, ts.VariableDeclaration>();
			for (const sf of files)
				for (const st of sf.statements)
					if (ts.isVariableStatement(st))
						for (const d of st.declarationList.declarations)
							if (ts.isIdentifier(d.name)) consts.set(`${sf.fileName}#${d.name.text}`, d);
			/** A const by name, in its own file or the file exporting it. */
			const lookup = (sf: ts.SourceFile, name: string) =>
				consts.get(`${sf.fileName}#${name}`) ??
				[...consts.entries()].find(
					([key, d]) =>
						key.endsWith(`#${name}`) &&
						(d.parent.parent.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
				)?.[1];
			const calls = (node: ts.Node): ts.CallExpression[] => {
				const found: ts.CallExpression[] = [];
				const visit = (n: ts.Node): void => {
					if (ts.isCallExpression(n)) found.push(n);
					n.forEachChild(visit);
				};
				visit(node);
				return found;
			};
			const callee = (c: ts.CallExpression) => c.expression.getText();
			const literal = (n: ts.Node | undefined) =>
				n !== undefined && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : undefined;
			const verbs: Verb[] = [];
			for (const d of consts.values()) {
				const make =
					d.initializer === undefined
						? undefined
						: calls(d.initializer).find((c) => callee(c) === 'Command.make');
				if (make !== undefined && ts.isIdentifier(d.name))
					verbs.push({ file: d.getSourceFile().fileName, name: d.name.text, at: d, make });
			}
			const parent = new Map<ts.VariableDeclaration, ts.VariableDeclaration>();
			for (const v of verbs)
				for (const c of calls(v.at).filter((c) => callee(c) === 'Command.withSubcommands'))
					for (const id of c.arguments[0] !== undefined && ts.isArrayLiteralExpression(c.arguments[0])
						? c.arguments[0].elements
						: [])
						if (ts.isIdentifier(id)) {
							const child = lookup(v.at.getSourceFile(), id.text);
							if (child !== undefined) parent.set(child, v.at);
						}
			const verbName = (v: Verb): string => literal(v.make.arguments[0]) ?? v.name;
			const path = (d: ts.VariableDeclaration): string[] => {
				const v = verbs.find((x) => x.at === d);
				const up = parent.get(d);
				return [...(up === undefined ? [] : path(up)), ...(v === undefined ? [] : [verbName(v)])];
			};
			/** One flag or argument: its kind, name and description, through a local const or helper. */
			const option = (sf: ts.SourceFile, key: string, expr: ts.Expression): DocParam => {
				const all = calls(expr);
				const ref = ts.isIdentifier(expr) ? lookup(sf, expr.text) : undefined;
				const helpers = [
					...all.flatMap((c) => (ts.isIdentifier(c.expression) ? [lookup(sf, c.expression.text)] : [])),
					ref
				].flatMap((d) => (d?.initializer === undefined ? [] : [d.initializer]));
				const chain = [...all, ...helpers.flatMap(calls)];
				const base = chain.find((c) => /^(Flag|Argument)\.(String|Boolean|Integer|Float|Choice|Path|File|Directory)$/.test(callee(c)));
				const named =
					literal(base?.arguments[0]) ?? literal(all.find((c) => ts.isIdentifier(c.expression))?.arguments[0]) ?? key;
				const flag = base === undefined ? true : callee(base).startsWith('Flag.');
				const kind = base === undefined ? 'String' : callee(base).split('.')[1];
				const variadic = chain.some((c) => callee(c) === 'Argument.variadic');
				const optional =
					variadic ||
					kind === 'Boolean' ||
					[expr, ...helpers].some((n) => /\b(Flag|Argument)\.(optional|withDefault)\b/.test(n.getText()));
				const description = chain
					.filter((c) => /\.withDescription$/.test(callee(c)))
					.map((c) => literal(c.arguments[0]))
					.find((t) => t !== undefined);
				return {
					name: flag ? `--${named}` : `<${named}${variadic ? '…' : ''}>`,
					type: kind === 'Boolean' ? 'boolean' : kind === 'Integer' || kind === 'Float' ? 'number' : 'string',
					...(optional ? { optional: true as const } : {}),
					...(description === undefined ? {} : { summary: description })
				};
			};
			const symbols = verbs.map((v): DocSymbol => {
				const sf = v.at.getSourceFile();
				const config = v.make.arguments[1];
				const params =
					config !== undefined && ts.isObjectLiteralExpression(config)
						? config.properties.flatMap((p) =>
								ts.isPropertyAssignment(p)
									? [option(sf, p.name.getText(), p.initializer)]
									: ts.isShorthandPropertyAssignment(p)
										? [option(sf, p.name.text, p.name)]
										: []
							)
						: [];
				const text = ts
					.getJSDocCommentsAndTags(v.at.parent.parent)
					.filter(ts.isJSDoc)
					.map((doc) => ts.getTextOfJSDocComment(doc.comment) ?? '')
					.join('\n')
					.trim();
				const name = ['bolt', ...path(v.at)].filter((w, i) => i === 0 || w !== 'bolt').join(' ');
				const usage = params
					.map((p) => (p.optional === true ? `[${p.name}]` : p.name))
					.join(' ');
				const summary = first(text);
				return {
					name,
					kind: 'command',
					signature: `${name}${usage === '' ? '' : ` ${usage}`}`,
					summary,
					...(text.replace(/\s+/g, ' ').trim() !== summary ? { docs: text } : {}),
					...(params.length === 0 ? {} : { params }),
					source: `packages/${posix(relative(root, sf.fileName))}:${sf.getLineAndCharacterOfPosition(v.at.getStart()).line + 1}`,
					group: path(v.at)[0] === 'templates' ? 'templates' : 'workspace'
				};
			});
			return {
				namespace: 'bolt-cli/cli',
				module: 'bolt',
				summary:
					"The `bolt` command (`@norbital-ai/bolt-cli`'s bin): a workspace's verbs, run inside it or given its directory, and the template repository's `bolt templates` CI verbs. Exit 0 ok, 1 author errors, 2 tool failure.",
				symbols: symbols.sort((a, b) => byCode(a.name, b.name))
			};
		}

		mkdirSync(out, { recursive: true });
		const index: DocIndex = { namespaces: [], missing: [], skills: [] };
		const contractSymbols = new Map<string, DocSymbol>();
		for (const name of readdirSync(SKILLS)
			.filter((n) => existsSync(join(SKILLS, n, 'SKILL.md')))
			.sort(byCode)) {
			const markdown = (dir: string): string[] =>
				readdirSync(join(SKILLS, name, dir), { withFileTypes: true }).flatMap((d) =>
					d.isDirectory()
						? markdown(posix(join(dir, d.name)))
						: d.name.endsWith('.md')
							? [posix(join(dir, d.name))]
							: []
				);
			const paths = [
				'SKILL.md',
				...markdown('.')
					.filter((p) => p !== 'SKILL.md')
					.sort(byCode)
			];
			const files = paths.map((path) => {
				const text = readFileSync(join(SKILLS, name, path), 'utf8');
				return {
					path,
					text:
						name === PRIMER_SKILL && path === 'SKILL.md'
							? `${text.trimEnd()}\n\n## Starters\n\nEach role's first file. Its symbols field by field, for a field a starter does not show: \`skill { name: '${CONTRACT_SKILL}', file: '<role>.md' }\`, roles ${Object.keys(CONTRACT).join(', ')}.\n\n${Object.keys(CONTRACT)
									.flatMap((role) => CONTRACT_HEAD[role] === undefined ? [] : [`### ${role}\n\n${CONTRACT_HEAD[role]}`])
									.join('\n\n')}\n`
							: text
				};
			});
			const description = (
				/^---\n[\s\S]*?^description:\s*(?:>-?\n)?([\s\S]*?)\n(?:\S[^\n]*:|---)/m.exec(
					files[0]?.text ?? ''
				)?.[1] ?? ''
			)
				.replace(/\s+/g, ' ')
				.trim();
			if (description === '')
				throw new Error(`[docs] oss/skills/${name}/SKILL.md has no description`);
			const skill: DocSkill = { name, description, files };
			writeFileSync(join(out, skill_file(name)), `${JSON.stringify(skill, null, '\t')}\n`);
			index.skills.push({ name, description, files: paths });
		}
		const namespaces: DocNamespace[] = entries.map((e) => {
			const sf = program.getSourceFile(e.file);
			const mod = sf === undefined ? undefined : checker.getSymbolAtLocation(sf);
			if (sf === undefined || mod === undefined)
				throw new Error(`[docs] ${e.namespace}: ${posix(relative(root, e.file))} is not built`);
			return {
				namespace: e.namespace,
				module: e.module,
				summary: entrySummary(e),
				symbols: grouped(
					checker
						.getExportsOfModule(mod)
						.map(symbolOf)
						.filter((s): s is DocSymbol => s !== null)
						.sort((a, b) => byCode(a.name, b.name))
				)
			};
		});
		namespaces.push(cliNamespace());
		namespaces.sort((a, b) => byCode(a.namespace, b.namespace));
		for (const ns of namespaces) {
			for (const s of ns.symbols) contractSymbols.set(`${ns.namespace}#${s.name}`, s);
			writeFileSync(
				join(out, `${ns.namespace.replaceAll('/', '.')}.json`),
				`${JSON.stringify(ns, null, '\t')}\n`
			);
			index.namespaces.push({
				namespace: ns.namespace,
				module: ns.module,
				summary: ns.summary,
				symbols: ns.symbols.length
			});
			for (const s of ns.symbols) {
				if (s.summary === '') index.missing.push(`${ns.namespace}#${s.name}`);
				for (const p of s.props ?? [])
					if (p.summary === undefined) index.missing.push(`${ns.namespace}#${s.name}.${p.name}`);
			}
		}

		const sentence = (text: string) =>
			clip(/^.*?(?<!e\.g|i\.e)\.(?=\s|$)/s.exec(text)?.[0] ?? text, 200);
		const line = (m: DocMember) =>
			`- ${m.name}${m.optional === true ? '?' : ''}: ${clip(m.type, 240)}${m.summary === undefined ? '' : ` — ${sentence(m.summary)}`}`;
		const card = (s: DocSymbol) => {
			const shape = [
				...(s.params ?? []).flatMap((p) => p.fields ?? []),
				...(s.props ?? []),
				...(s.members ?? [])
			];
			return [
				`## ${s.name}`,
				sentence(s.summary),
				...(s.kind === 'function' ? [clip(s.signature, 300)] : []),
				...(shape.length > 0
					? shape.map(line)
					: s.kind === 'function'
						? []
						: [s.signature.replace(/\s+/g, ' ')])
			]
				.filter((part) => part !== '')
				.join('\n');
		};
		const roles = Object.entries(CONTRACT).map(([role, named]) => ({
			path: `${role}.md`,
			text: `# ${role}\n\n${Object.entries(
				named
			)
				.flatMap(([namespace, names]) =>
					names.map((name) => {
						const found = contractSymbols.get(`${namespace}#${name}`);
						if (found === undefined) throw new Error(`[docs] no ${namespace}#${name} for a card`);
						return card(found);
					})
				)
				.join('\n\n')}\n`
		}));
		const description = "Bolt's authoring contract: one card per role, generated from its types.";
		const contract: DocSkill = {
			name: CONTRACT_SKILL,
			description,
			files: [
				{
					path: 'SKILL.md',
					text: `---\ndescription: ${description}\n---\n\n# Bolt contract\n\nOne card per role, read with \`file\`: ${roles.map((r) => r.path).join(', ')}.\n`
				},
				...roles
			]
		};
		writeFileSync(
			join(out, skill_file(CONTRACT_SKILL)),
			`${JSON.stringify(contract, null, '\t')}\n`
		);
		index.skills.push({
			name: CONTRACT_SKILL,
			description,
			files: contract.files.map((file) => file.path)
		});
		writeFileSync(join(out, 'index.json'), `${JSON.stringify(index, null, '\t')}\n`);
		console.log(
			`[docs] ${index.namespaces.map((n) => `${n.namespace} ${n.symbols}`).join(', ')}; ${index.missing.length} reference symbols without a summary; skills ${index.skills.map((k) => k.name).join(', ')}`
		);
	},
	catch: (cause) =>
		new DocsFailed({ message: cause instanceof Error ? cause.message : String(cause), cause })
});

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1])
	NodeRuntime.runMain(generateDocs);
