// The authoring reference the agent reads, taken from the built declarations rather than written
// by hand: a section per concern, each the verbatim `.d.ts` text (doc comments included) of the
// declarations named below. The names are the one curated thing; the text can never drift from
// the types because it *is* the types. `node scripts/authoring-reference.mjs` rewrites the module
// after `pnpm build`; `tests/authoring-reference.test.ts` fails when the committed module is stale.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = fileURLToPath(new URL('.', import.meta.url));
const AUTHORING = `${here}../build/authoring/`;
const PROTOCOL = `${here}../../bolt-protocol/build/`;
export const OUTPUT = `${here}../src/runtime/agents/authoring-reference.generated.ts`;

/** Section title → the declarations it shows, by built file. */
export const SECTIONS = [
	{
		title: 'Server api',
		files: {
			[`${AUTHORING}contracts-schema.d.ts`]: [
				'Api',
				'CollectionQuery',
				'CollectionWriteApi',
				'SchemaQueryConfig',
				'CollectionPipelines'
			]
		}
	},
	{
		title: 'Automations',
		files: {
			[`${AUTHORING}automations-schema.d.ts`]: [
				'AutomationTrigger',
				'AutomationApi',
				'AutomationContext',
				'AutomationDefinition',
				'DefineAutomation',
				'defineAutomation'
			]
		}
	},
	{
		title: 'Collections and notifications',
		files: {
			[`${AUTHORING}collection-schema.d.ts`]: [
				'CollectionDeclaration',
				'CollectionOperationDeclaration',
				'CollectionTransform',
				'CollectionLifecycleEvent',
				'CollectionNotificationEvent',
				'CollectionNotificationRule',
				'CollectionNotifications'
			],
			[`${PROTOCOL}facilities.d.ts`]: ['NotificationRecipient']
		}
	},
	{
		title: 'Channels',
		files: {
			[`${AUTHORING}channels-schema.d.ts`]: [
				'MessageFor',
				'EnvelopeFor',
				'ChannelsApi',
				'NotifyInput',
				'NotifyApi',
				'OutboundRule',
				'ChannelEvents',
				'ChannelDefinition',
				'defineChannel'
			],
			[`${PROTOCOL}channels.d.ts`]: ['ChatMessage', 'EmailMessage', 'InboxMessage', 'HttpRequest']
		}
	},
	{
		title: 'Integrations',
		files: {
			[`${AUTHORING}integrations-schema.d.ts`]: [
				'PageSpec',
				'ListSpec',
				'ChangesSpec',
				'HttpRecordsSpec',
				'FieldMapping',
				'ConflictRule',
				'OneWaySync',
				'TwoWaySync',
				'IntegrationDefinition',
				'defineIntegration',
				'http',
				'channel'
			]
		}
	},
	{
		title: 'Model columns',
		files: {
			[`${AUTHORING}models-schema.d.ts`]: [
				'defineModel',
				'ModelMetadata',
				'ModelEmbedding',
				'text',
				'numeric',
				'instant',
				'enums',
				'file',
				'vector',
				'reference',
				'custom',
				'group',
				'cascade',
				'setNull',
				'deferrable',
				'geolocation',
				'phone'
			],
			[`${AUTHORING}refusal.d.ts`]: ['refuse']
		}
	},
	{
		title: 'Policies, approvals, teams',
		files: {
			[`${AUTHORING}contracts-schema.d.ts`]: [
				'PolicyDefinition',
				'PolicyDecisionApi',
				'ApprovalFlow',
				'ApprovalReviewFlow',
				'NoApprovalFlow',
				'Teams'
			],
			[`${AUTHORING}approval-flow.d.ts`]: ['approveBy', 'noApproval']
		}
	},
	{
		title: 'Functions',
		files: {
			[`${AUTHORING}handlers-schema.d.ts`]: [
				'DefineQueryHandler',
				'DefineCommandHandler',
				'defineQueryHandler',
				'defineCommandHandler'
			]
		}
	}
];

/** @param {ts.Statement} statement */
const declaredName = (statement) => {
	if (
		ts.isTypeAliasDeclaration(statement) ||
		ts.isInterfaceDeclaration(statement) ||
		ts.isFunctionDeclaration(statement) ||
		ts.isClassDeclaration(statement)
	)
		return statement.name?.text === undefined ? [] : [statement.name.text];
	if (ts.isVariableStatement(statement))
		return statement.declarationList.declarations.flatMap((declaration) =>
			ts.isIdentifier(declaration.name) ? [declaration.name.text] : []
		);
	return [];
};

/** A file reader, so a test can feed the renderer without touching disk. */
export const readBuilt = (/** @type {string} */ file) => readFileSync(file, 'utf8');

/**
 * The named declarations of one built file, doc comments included, in the order asked for.
 * @param {string} path
 * @param {ReadonlyArray<string>} names
 * @param {(file: string) => string} read
 */
export const declarations = (path, names, read = readBuilt) => {
	const source = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true);
	/** @type {Map<string, string>} */
	const found = new Map();
	for (const statement of source.statements)
		for (const name of declaredName(statement))
			if (names.includes(name) && !found.has(name))
				found.set(
					name,
					statement
						.getFullText(source)
						.replace(/^\s*\n/, '')
						.trimEnd()
				);
	const missing = names.filter((name) => !found.has(name));
	if (missing.length > 0)
		throw new Error(`${path} no longer declares ${missing.join(', ')}; update SECTIONS.`);
	return names.map((name) => found.get(name));
};

/** @param {(file: string) => string} read */
export const render = (read = readBuilt) => {
	const sections = SECTIONS.map(({ title, files }) => ({
		title,
		body: Object.entries(files)
			.flatMap(([path, names]) => declarations(path, names, read))
			.join('\n\n')
	}));
	return `// Generated by scripts/authoring-reference.mjs from the built declarations — do not edit.
// The types are the reference: run \`pnpm build && node scripts/authoring-reference.mjs\` after
// changing anything under src/authoring, and the test of the same name fails until you do.
export const AUTHORING_REFERENCE: ReadonlyArray<{ readonly title: string; readonly body: string }> =
	${JSON.stringify(sections, null, '\t').replace(/\n/g, '\n\t')};
`;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	writeFileSync(OUTPUT, render());
	console.log(`wrote ${OUTPUT}`);
}
