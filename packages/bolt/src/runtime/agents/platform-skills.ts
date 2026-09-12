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
  collections/<name>/+representation.svelte  optional custom create/edit/display
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
import { defineModel, enums, text, number, instant, boolean, file, r, custom } from '@norbital-ai/bolt/authoring';

export default defineModel(
  {
    title: text().notNull(),
    status: enums(['open', 'closed']),
    budget: number(),
    due: instant(),
    active: boolean(),
    attachment: file(),
    account_id: r.uuid()            // scalar reference; wire it in +relationship.ts
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

\`src/collections/+relationship.ts\` declares how collections join. Then a model may name a related
record with nested reads/writes from the client. Keep scalar \`r.uuid()\` columns for the foreign key.

## Apps

An app is \`src/apps/+<app>.svelte\`. Every app is one \`Cover\` with a page heading and exactly one
body region; that region owns the inset, the concrete surface owns scrolling.

\`\`\`svelte
<script lang="ts">
  import { client } from '$bolt/client';
  import { CollectionTable } from '@norbital-ai/ui/collection-table';
  import { Bound, Cover } from '@norbital-ai/ui/layout';
  import { PageHeader } from '@norbital-ai/ui/page-header';
</script>

<svelte:head>
  <title>Accounts</title>
  <meta name="bolt:icon" content="lucide:building" />
</svelte:head>

{#snippet pageHeading()}
  <PageHeader title="Accounts" description="Companies you sell to." />
{/snippet}

<Cover as="main" top={pageHeading}>
  <Bound size="full" inset>
    <CollectionTable {client} collection="accounts">
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

## Copy

Every user-facing string comes from \`t('key')\` using your \`src/i18n/messages.en.json\` (mirror the
keys in \`messages.zh.json\`). App identity keys are \`app.<app>.title\`, \`app.<app>.header_title\`,
\`app.<app>.header_description\`.

## The generated workspace tree (.norbital)

\`bolt sync\` owns this; do not hand-edit it. Know where to look:
- \`.norbital/generated/authoring-types.ts\` — the exact generated types for your models, fields,
  client methods, and app props. This is the source of truth for signatures. Read it when unsure.
- \`.norbital/generated/collections.js\`, \`client.*\` — the compiled client and registry.
- \`.norbital/diagnosis/findings.tsv\` — the audit's findings (one row per finding) after a build.
- \`.norbital/migrations/\` — committed schema history; \`.norbital/config/\` — authored doctor config.

If a path under \`.norbital\` is not listed by \`workspace_files\`, ask the host to compile the draft
(\`workspace_validate\`) and read the diagnostics it returns.

## Method

1. Read the existing source (\`workspace_files\`, \`workspace_read\`) before writing.
2. State the collections and app surfaces you will add; then author with \`workspace_edit\` (precise
   replacements) or \`workspace_apply\` (whole files). Supply the current \`expectedCommit\`; a stale
   commit fails without partial changes — re-read and retry.
3. Call \`workspace_validate\`. Fix every error it returns and call it again until clean.
4. Only then report what you changed, by file, and what it does. Never claim a path compiles because
   it looks right.`;

export const PLATFORM_SKILLS: ReadonlyArray<SkillDeclaration> = [
	{ name: 'authoring-tenant-workspace', body: AUTHORING_CONTRACT }
];
