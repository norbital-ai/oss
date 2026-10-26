// The source layout (§3.2): the file roles discovery reads, and the help text that prints them. Discovery and the
// agent's prompt both read this table, so the layout a model is told is the layout the compiler enforces.
/** The file roles of §3.2. `dir` is under `src/`: `*` is one name segment, `**` one or more (app paths); `*` in `file` is the name. */
export const ROLES = [
	{ role: 'workspace', dir: '', file: '+workspace.ts' },
	{ role: 'secrets', dir: '', file: '+secrets.ts' },
	{ role: 'model', dir: 'data/model/*', file: '+model.ts' },
	{ role: 'representation', dir: 'data/model/*', file: '+representation.svelte' },
	{ role: 'custom_field', dir: 'data/custom_field/*', file: '+definition.ts' },
	{ role: 'renderer', dir: 'data/custom_field/*', file: '+renderer.svelte' },
	{ role: 'integration_definition', dir: 'integration/*', file: '+integration.ts' },
	{ role: 'integration_setup', dir: 'integration/*', file: '+integration.svelte' },
	{ role: 'policy', dir: 'access_control/policy', file: '+*.policy.ts' },
	{ role: 'team', dir: 'access_control/team', file: '+team.ts' },
	{ role: 'agent', dir: 'agent', file: '+agent.md' },
	{ role: 'agent_external', dir: 'agent', file: '+agent.external.md' },
	{ role: 'envoy', dir: 'agent/envoy', file: '+*.envoy.ts' },
	{ role: 'skill', dir: 'agent/skill/*', file: '+skill.md' },
	{ role: 'mcp', dir: 'agent/mcp', file: '+*.mcp.ts' },
	{ role: 'automation', dir: 'automation', file: '+*.automation.ts' },
	{ role: 'app', dir: 'app/**', file: '+app.ts' },
	{ role: 'kiosk', dir: 'kiosk/**', file: '+kiosk.ts' },
	{ role: 'kiosk_page', dir: 'kiosk/**', file: '+*.page.svelte' },
	{ role: 'kiosk_page_server', dir: 'kiosk/**', file: '+*.page.server.ts' },
	{ role: 'session', dir: 'app/**', file: '+session.svelte' },
	{ role: 'page', dir: 'app/**', file: '+*.page.svelte' },
	{ role: 'page_server', dir: 'app/**', file: '+*.page.server.ts' },
	{ role: 'messages', dir: 'i18n', file: '+messages.ts' },
	{ role: 'locale', dir: 'i18n', file: '+*.messages.ts' },
	{ role: 'group', dir: 'app/**', file: '+group.ts' }
] as const;
export type Role = (typeof ROLES)[number]['role'];

export const NAME = /^[a-z][a-z0-9_]*$/;
/** A folder pattern as the author reads it: an app's or kiosk's folder names it, any other folder names its thing. */
const placeholders = (dir: string) =>
	dir
		.split('/')
		.map((seg, i, all) =>
			seg === '**' && (all[i - 1] === 'app' || all[i - 1] === 'kiosk')
				? `<${all[i - 1]}>`
				: seg.includes('*')
					? '<name>'
					: seg
		)
		.join('/');
/** The help text of every layout error prints the §3.2 table. */
export const LAYOUT_HELP = `A + file is a compiler role; files without + are ordinary modules and may sit anywhere.
If the folder names the thing the file is +<role>.<ext>, otherwise +<name>.<role>.<ext>. Folder names are singular;
names match ${NAME.source}. The roles:
${ROLES.map((r) => `  src/${placeholders(r.dir)}${r.dir ? '/' : ''}${r.file.replace('*', '<name>')}`).join('\n')}`;
