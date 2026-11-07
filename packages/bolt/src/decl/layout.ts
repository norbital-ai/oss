// The source layout (§3.2): the file roles discovery reads, and the help text that prints them. Discovery and the
// agent's prompt both read this table, so the layout a model is told is the layout the compiler enforces.
/** The file roles of §3.2. `dir` is under `src/`: `*` is one name segment, `**` one or more; `*` in `file` is the name. */
export const ROLES = [
	{
		role: 'workspace',
		dir: '',
		file: '+workspace.ts',
		note: 'zone, locale, connections'
	},
	{ role: 'secrets', dir: '', file: '+secrets.ts', note: '' },
	{
		role: 'model',
		dir: 'data/model/**',
		file: '+model.ts',
		note: 'fields, state, reads, writes'
	},
	{
		role: 'representation',
		dir: 'data/model/**',
		file: '+representation.svelte',
		note: 'record view'
	},
	{
		role: 'custom_field',
		dir: 'data/custom_field/*',
		file: '+definition.ts',
		note: 'custom field type'
	},
	{
		role: 'renderer',
		dir: 'data/custom_field/*',
		file: '+renderer.svelte',
		note: 'field renderer'
	},
	{
		role: 'integration_definition',
		dir: 'integration/*',
		file: '+integration.ts',
		note: ''
	},
	{
		role: 'integration_setup',
		dir: 'integration/*',
		file: '+integration.svelte',
		note: 'setup screen'
	},
	{
		role: 'policy',
		dir: 'access_control/policy',
		file: '+*.policy.ts',
		note: 'what holders may do'
	},
	{
		role: 'team',
		dir: 'access_control/team',
		file: '+team.ts',
		note: 'teams and their policies'
	},
	{ role: 'agent', dir: 'agent', file: '+agent.md', note: 'agent brief for staff' },
	{
		role: 'agent_external',
		dir: 'agent',
		file: '+agent.external.md',
		note: 'agent brief for external members'
	},
	{ role: 'envoy', dir: 'agent/envoy', file: '+*.envoy.ts', note: 'envoy default' },
	{
		role: 'skill',
		dir: 'agent/skill/*',
		file: '+skill.md',
		note: 'agent skill'
	},
	{ role: 'tool', dir: 'agent/tool/*', file: '+tool.ts', note: 'agent tool; its body is run.ts' },
	{ role: 'mcp', dir: 'agent/mcp', file: '+*.mcp.ts', note: 'MCP server' },
	{
		role: 'automation',
		dir: 'automation',
		file: '+*.automation.ts',
		note: 'job run with its own policies'
	},
	{ role: 'app', dir: 'app/**', file: '+app.ts', note: 'app label and pages' },
	{
		role: 'kiosk',
		dir: 'kiosk/**',
		file: '+kiosk.ts',
		note: 'standalone surface'
	},
	{ role: 'kiosk_page', dir: 'kiosk/**', file: '+*.page.svelte', note: '' },
	{
		role: 'kiosk_page_server',
		dir: 'kiosk/**',
		file: '+*.page.server.ts',
		note: 'server side of the page'
	},
	{
		role: 'session',
		dir: 'app/**',
		file: '+session.svelte',
		note: 'device work for the whole session'
	},
	{ role: 'page', dir: 'app/**', file: '+*.page.svelte', note: '' },
	{
		role: 'page_server',
		dir: 'app/**',
		file: '+*.page.server.ts',
		note: 'server side of the page'
	},
	{ role: 'messages', dir: 'i18n', file: '+messages.ts', note: 'base text' },
	{ role: 'locale', dir: 'i18n', file: '+*.messages.ts', note: 'translation' },
	{ role: 'group', dir: 'app/**', file: '+group.ts', note: 'app group' }
] as const;
export type Role = (typeof ROLES)[number]['role'];

const escape = (s: string) => s.replace(/[.+]/g, '\\$&');
export const fileRe = (file: string) => new RegExp(`^${escape(file).replace('*', '([^.]+)')}$`);
/** Matches a dir pattern; returns the folder name (`''` when the pattern has none) or undefined. */
export function matchDir(pattern: string, segs: string[]): string | undefined {
	const p = pattern === '' ? [] : pattern.split('/');
	if (p.at(-1) === '**') {
		const fixed = p.slice(0, -1);
		return segs.length > fixed.length && fixed.every((s, i) => s === segs[i])
			? segs.slice(fixed.length).join('/')
			: undefined;
	}
	if (p.length !== segs.length) return undefined;
	let name = '';
	for (const [i, s] of p.entries()) {
		if (s === '*') name = segs[i]!;
		else if (s !== segs[i]) return undefined;
	}
	return name;
}
/** The role a workspace-relative path holds, if any. */
export function roleAt(path: string) {
	const segs = path.split('/').slice(1),
		base = segs.pop() ?? '';
	if (!path.startsWith('src/') || !base.startsWith('+')) return undefined;
	return ROLES.find((r) => fileRe(r.file).test(base) && matchDir(r.dir, segs) !== undefined);
}
/** What a folder holds, where its name does not say. */
export const FOLDER_NOTES: { readonly [dir: string]: string } = {
	'src/': 'compiled source: + files are compiler roles, the rest ordinary modules',
	'src/data/model/': 'one folder per model; a child model is a folder inside its owner',
	'migrations/': 'generated SQL history'
};

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
names match ${NAME.source}. Model folders may nest under models or plain grouping folders; only the leaf folder names
the model, uniquely across the workspace. A representation sits beside its model. The roles:
${ROLES.map((r) => `  src/${placeholders(r.dir)}${r.dir ? '/' : ''}${r.file.replace('*', '<name>')}`).join('\n')}`;
