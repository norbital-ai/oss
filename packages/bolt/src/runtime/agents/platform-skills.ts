import type { SkillDeclaration } from '../../authoring/workspace-schema.js';

/**
 * Skills the host supplies to every workspace agent, beside the ones the workspace authors.
 *
 * A tenant starts empty and is built by its agent; that agent cannot read `node_modules`, and the
 * published `authoring-tenant-workspace` skill is a repository artifact, not something a tenant
 * installs. Without a contract in hand it researches instead of authoring. This skill is that
 * contract, carried in the runtime so it is present in every workspace and pinned to the platform
 * version that compiled it. A workspace skill of the same name wins.
 */
const AUTHORING_CONTRACT = `# Authoring a Norbital tenant workspace

You can author this workspace's source and it will be compiled and served. Write the files below;
never hand-edit generated output. You have no shell — to compile and lint a draft, call the
\`workspace_validate\` host tool (it runs install + sync + lint + audit in the workspace sandbox and
returns diagnostics). Read its findings and fix them; do not claim success without it.

## The authored filesystem

\`\`\`text
src/
  +agents.md                      shared workspace prompt (web + envoy turns)
  +env.ts                         optional declared env vars
  access/+teams.ts                team -> policy names
  access/policies/+<name>.ts      grants/approvals/capabilities/limits
  collections/+relationship.ts    cross-collection relations
  collections/<name>/+model.ts    the collection's columns
  collections/<name>/+hooks.ts    optional validation/write hooks
  collections/<name>/+pipelines.ts optional import/export
  collections/<name>/+representation.svelte  required for user-facing create/edit/display
  datatypes/<name>/+definition.ts + +renderer.svelte  named domain values
  apps/+<app>.svelte              an app surface
  automations/+<name>.ts          durable, after-commit work
  envoys/+<name>.ts               a channel persona
  functions/+<name>.ts            request/response handlers
  i18n/messages.en.json + messages.zh.json  bilingual catalogs (both required)
\`\`\`

A leading \`+\` is a compiler role; a misplaced or unknown one is an error. Everything else under
\`src/\` is ordinary source the compiler does not claim.

## Collections

\`\`\`ts
import { defineModel, enums, text, numeric, instant, boolean, file, uuid, custom } from '@norbital-ai/bolt/authoring';

export default defineModel(
  {
    title: text().notNull(),
    status: enums(['open', 'closed']),
    budget: numeric(),
    due: instant(),
    active: boolean(),
    attachment: file(),
    account_id: uuid()             // scalar reference; wire it in +relationship.ts
  },
  { description: '...', recordLabel: 'title', icon: 'lucide:file-question' }
);
\`\`\`

- The directory name is the collection name. \`defineModel(columns, metadata?)\`.
- \`recordLabel\` is one text field or an ordered tuple of text fields; it is never an \`instant()\`.
- \`custom('money')\` and \`custom('instant_range')\` are platform datatypes; \`custom('<name>')\` binds a
  datatype you declare under \`src/datatypes/<name>/\`.
- \`.notNull()\` when a value is required; nothing is required by default.

## Relations

\`src/collections/+relationship.ts\` declares how collections join. Keep scalar \`uuid()\` columns
for foreign keys. The compiler generates the local \`$types.js\` import during validation:

\`\`\`ts
import type { Relationships } from './$types.js';

export default ((r) => ({
  accounts: { account_contacts: r.many.contacts() },
  contacts: {
    contact_account: r.one.accounts({ from: r.contacts.account_id, to: r.accounts.id })
  }
})) satisfies Relationships;
\`\`\`

Each relation has a unique name; declare the one side with explicit \`from\` and \`to\`, then the
inverse many side. Relationship fields get record pickers in the platform's create/edit forms.

## Record forms

A model and table alone do not provide a create/edit form. Every collection users create or open
needs an explicit \`+representation.svelte\`; otherwise New shows "requires an explicit representation".
Author it with the model, then test creating and reopening a record in the browser:

\`\`\`svelte
<script lang="ts">
  import { client } from '$bolt/client';
  import type { RepresentationProps } from './$types.js';
  import { getCollectionClientForSurface } from '@norbital-ai/ui/collection-runtime';
  import { CollectionForm } from '@norbital-ai/ui/collection-form';
  import { Grid } from '@norbital-ai/ui/layout';

  let { record, close }: RepresentationProps = $props();
  const workspaceClient = getCollectionClientForSurface(client, 'accounts form');
</script>

<CollectionForm client={workspaceClient} collection="accounts"
  defaultValues={record ?? undefined} onAfterSubmit={record ? undefined : close}>
  {#snippet children({ Field })}
    <Grid minimum="compact">
      <Field name="name" />
      <Field name="status" />
    </Grid>
  {/snippet}
</CollectionForm>
\`\`\`

Declare every mutable field exactly once, including relationship and file fields; use
\`<Field name="internal_value" hidden />\` for a value users must not edit. Framework fields such as
\`id\` are hidden automatically. A relationship Field
can use \`relationOptions={{ label: (row) => String(row.name ?? ''), orderBy: { name: 'asc' } }}\`
to show meaningful record names. CollectionForm supplies validation and save controls.

## Apps

An app is \`src/apps/+<app>.svelte\`. The workspace shell renders its translated page heading.
Do not repeat it inside the app. Use one \`Cover\` and exactly one body region; that region owns
the inset, the concrete surface owns scrolling.

\`\`\`svelte
<script lang="ts">
  import { client } from '$bolt/client';
  import { getCollectionClientForSurface } from '@norbital-ai/ui/collection-runtime';
  import { CollectionTable } from '@norbital-ai/ui/collection-table';
  import { Bound, Cover } from '@norbital-ai/ui/layout';

  const workspaceClient = getCollectionClientForSurface(client, 'accounts');
</script>

<svelte:head>
  <title>Accounts</title>
  <meta name="description" content="Companies you sell to." />
  <meta name="bolt:icon" content="lucide:building" />
</svelte:head>

<Cover as="main">
  <Bound size="full" inset>
    <CollectionTable client={workspaceClient} collection="accounts" view="accounts:table">
      {#snippet columns({ Column })}
        <Column name="name" />
        <Column name="status" />
      {/snippet}
    </CollectionTable>
  </Bound>
</Cover>
\`\`\`

Data is a single typed client: \`import { client } from '$bolt/client'\`. Reads are live reactive
queries (\`client.db.<collection>.findMany({ where, orderBy, columns, with })\`); writes are
\`client.db.<collection>.mutate([...])\`. There is no refetch/invalidate in the client.

Apps use Svelte 5 runes: \`let selected = $state('')\`, \`const rows = $derived(query.current ?? [])\`,
and \`onclick={handler}\`. Keep the query reactive; its first \`current\` may be empty while it loads.
Do not copy it once on mount. Filters use operators, for example \`where: { id: { eq: selected } }\`.
Svelte templates are not JSX: declare \`{#snippet editor()}...{/snippet}\` in the markup and pass
\`editor\` as a snippet prop. Do not import React-style \`useState\` or \`useEffect\` from Svelte, or mix
legacy \`$:\` statements with runes. Import UI components from their public subpaths, such as
\`@norbital-ai/ui/button\` and \`@norbital-ai/ui/tabs\`, not the package root.

Prefer callbacks for user actions. When a reactive side effect is necessary, import \`watch\` from
\`runed\`: \`watch(() => selected, (value, previousValue) => { /* react to this source only */ })\`.
It runs initially; optional third argument \`{ lazy: true }\` skips that first run. Do not overwrite
unsaved input on every live-query emission; use an explicit Load action for saved document content.

For a custom save action, import \`submitCollectionMutation\` from
\`@norbital-ai/ui/collection-form\` and \`Effect\` from \`effect\`:
\`await Effect.runPromise(submitCollectionMutation(() => client.db.documents.mutate([values])))\`.
The result is a settlement with \`kind: 'committed' | 'pendingApproval'\`, not an array of rows.
For a new record, omit \`id\`: the client generates it. Supplying \`id\` means UPDATE and requires
an existing row in the live query. To retain a created id, capture \`handle.row?.id\` from the
Promise returned by \`mutate\` inside the callback, return that handle, and retain the id only
after a committed settlement. Report pending approval accurately.

To upload a browser File, import \`getDataRendererRuntimeContext\` from
\`@norbital-ai/ui/data-renderer\` and capture \`const runtime = getDataRendererRuntimeContext()\`
during component initialization, never inside an event handler. Obtain
\`runtime?.createFileUploadClient()\`; if unavailable, report that upload is unavailable.
\`await Effect.runPromise(uploadClient.upload(file))\` returns \`storageKey, name, size, type\`.
Store a \`file()\` value as \`{ storage_key: result.storageKey, file_name: result.name,
file_size: result.size, mime_type: result.type }\`; \`runtime.fileUrl(storage_key)\` resolves downloads.

## Copy

Every visible body string comes from \`t('key')\` using your \`src/i18n/messages.en.json\` (mirror the
keys in \`messages.zh.json\`). App identity keys are \`app.<app>.title\`, \`app.<app>.header_title\`,
\`app.<app>.header_description\`. Keep head metadata static English: the compiler extracts it as
text, and \`app.<app>.title\` supplies the translated sidebar name.

## The generated workspace tree (.norbital)

\`bolt sync\` owns this; do not hand-edit it. Know where to look:
- \`.norbital/generated/authoring-types.ts\` — generated types for models and fields. Generated
  files and dependencies are not exposed through \`workspace_read\`; do not try to read them.
- \`.norbital/generated/collections.js\`, \`client.*\` — the compiled client and registry.
- \`.norbital/diagnosis/findings.tsv\` — the audit's findings (one row per finding) after a build.
- \`.norbital/migrations/\` — committed schema history; \`.norbital/config/\` — authored doctor config.

Validation returns diagnostics directly; it does not add generated files to the authored draft.
Do not validate an unchanged draft to discover more files. Author a small step, then validate it.

## Method

1. Read the existing source (\`workspace_files\`, \`workspace_read\`) before writing.
   Child agents have the same source access; delegating a dependency-signature lookup does not
   expose node_modules. Use this contract and compiler diagnostics instead of recursive lookups.
2. State the collections and app surfaces you will add; then author a small batch with \`workspace_edit\` (precise
   replacements) or \`workspace_apply\` (whole files). Supply the current \`expectedCommit\`; a stale
   commit fails without partial changes — re-read and retry.
3. Call \`workspace_validate\`. Fix every error it returns and call it again until clean.
4. Only then report what you changed, by file, and what it does. Never claim a path compiles because
   it looks right.`;

export const PLATFORM_SKILLS: ReadonlyArray<SkillDeclaration> = [
	{ name: 'authoring-tenant-workspace', body: AUTHORING_CONTRACT }
];
