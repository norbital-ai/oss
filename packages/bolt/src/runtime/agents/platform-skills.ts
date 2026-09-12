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

## Apps

An app is \`src/apps/+<app>.svelte\`. Every app is one \`Cover\` with a page heading and exactly one
body region; that region owns the inset, the concrete surface owns scrolling.

\`\`\`svelte
<script lang="ts">
  import { client } from '$bolt/client';
  import type { TenantI18nKeys } from '$bolt/i18n-keys';
  import { getCollectionClientForSurface } from '@norbital-ai/ui/collection-runtime';
  import { CollectionTable } from '@norbital-ai/ui/collection-table';
  import { useI18n } from '@norbital-ai/ui/i18n';
  import { Bound, Cover } from '@norbital-ai/ui/layout';
  import { PageHeader } from '@norbital-ai/ui/page-header';

  const { t } = useI18n<TenantI18nKeys>();
  const workspaceClient = getCollectionClientForSurface(client, 'accounts');
</script>

<svelte:head>
  <title>Accounts</title>
  <meta name="description" content="Companies you sell to." />
  <meta name="bolt:icon" content="lucide:building" />
</svelte:head>

{#snippet pageHeading()}
  <PageHeader
    title={t('app.accounts.header_title')}
    description={t('app.accounts.header_description')}
  />
{/snippet}

<Cover as="main" top={pageHeading}>
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
2. State the collections and app surfaces you will add; then author a small batch with \`workspace_edit\` (precise
   replacements) or \`workspace_apply\` (whole files). Supply the current \`expectedCommit\`; a stale
   commit fails without partial changes — re-read and retry.
3. Call \`workspace_validate\`. Fix every error it returns and call it again until clean.
4. Only then report what you changed, by file, and what it does. Never claim a path compiles because
   it looks right.`;

export const PLATFORM_SKILLS: ReadonlyArray<SkillDeclaration> = [
	{ name: 'authoring-tenant-workspace', body: AUTHORING_CONTRACT }
];
