// The shell routes' answers decode with real Schemas (boot, settings, studio): every key the host's types carry
// survives the decode (an excess key refuses), and a malformed answer is the shell's protocol failure.
import { describe, expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import {
	SettingsAnswer,
	ShellBootAnswer,
	StudioAuditAnswer,
	StudioAuditRulesAnswer,
	StudioBuildAnswer,
	StudioFileAnswer,
	StudioViewAnswer
} from '../src/shell/api-types.ts';
import { shellApi } from '../src/shell/runtime.ts';
import type { ShellBoot } from '../src/shell/nav.ts';
import type { Settings } from '../src/shell/settings/data.ts';
import type { StudioBuildRecord, StudioFile, StudioView } from '../src/shell/studio/model.ts';
import type { StudioAudit, StudioAuditRules } from '../src/shell/studio/audit.ts';

const strict = <A>(schema: Schema.Decoder<A>, value: A) =>
	expect(Schema.decodeUnknownSync(schema)(value, { onExcessProperty: 'error' })).toEqual(value);

const boot = {
	workspace: {
		name: 'Acme',
		locale: 'en',
		tz: 'UTC',
		logo: '/logo.svg',
		environment: 'local',
		handle: 'acme',
		apex: 'https://example.test',
		live: 'https://acme.example.test',
		organization: true
	},
	actor: {
		kind: 'member',
		id: 'u1',
		email: 'a@example.test',
		phone: null,
		external: false,
		teams: ['ops'],
		teamPath: ['ops'],
		admin: true,
		party: { model: 'customer', id: 'c1' }
	},
	name: 'Ann',
	admin: true,
	preview: { team: 'ops', by: 'u2' },
	notice: { text: 'Trial ends', tone: 'warning', href: '/billing', action: 'Upgrade' },
	workspaces: [{ handle: 'beta', name: 'Beta', href: '/beta' }],
	nav: [
		{
			kind: 'group',
			name: 'g',
			title: 'G',
			description: 'Group',
			icon: 'folder',
			href: '/g',
			children: [
				{
					kind: 'app',
					name: 'crm',
					title: 'CRM',
					description: 'Customers',
					icon: 'users',
					banner: '/banner.svg',
					href: '/app/crm',
					pages: [
						{ name: 'home', title: 'Home', icon: 'home', section: 'Main', portal: true, href: '/' }
					]
				}
			]
		}
	],
	surfaces: { inbox: true, runs: true, settings: true, agent: true, studio: true },
	inbox: 2,
	kiosks: [{ name: 'desk', title: 'Desk', icon: 'tablet', href: '/kiosk/desk' }],
	startable: [{ name: 'sync', description: 'Sync now' }],
	envoys: { helper: 'Helper' },
	push: 'vapid',
	visitor: { app: 'shop', siteKey: 'site' },
	catalog: {
		customer: {
			label: ['name'],
			search: ['name'],
			semantic: true,
			indexes: { near: { input: { q: { kind: 'text' } }, description: 'Near' } },
			fields: { name: { kind: 'text', default: 'Ann' }, holder: { kind: 'text' } },
			relations: {
				holder: {
					targets: ['sys_user'],
					optional: true,
					label: 'Holder',
					inverse: 'customers',
					where: { active: true }
				}
			},
			layers: ['holder'],
			many: ['orders'],
			children: { orders: { model: 'order', parent: 'customer', owned: true } },
			output: 'brief',
			create: {
				columns: ['name'],
				filled: ['holder'],
				proposalOnly: true,
				with: {
					orders: {
						model: 'order',
						parent: 'customer',
						owned: true,
						create: { columns: ['total'], filled: [], proposalOnly: true },
						update: { columns: ['total'] },
						delete: true,
						link: true,
						unlink: true
					}
				}
			},
			update: { columns: ['name'], with: {} },
			readonlyFields: { name: 'syncOwned' },
			locked: { status: 'closed' },
			description: 'Customers',
			delete: true,
			syncs: {
				file: {
					kind: 'file',
					parser: ['csv', { type: 'text/x', extensions: ['x'] }],
					import: true
				},
				remote: { kind: 'remote', with: 'crm' }
			}
		}
	},
	automations: { sync: { input: { since: { kind: 'date' } }, description: 'Sync' } },
	aiUnconfigured: true,
	contract: 'abc'
} satisfies ShellBoot;

const settings = {
	members: [
		{
			id: 'u1',
			email: 'a@example.test',
			phone: null,
			telegram: null,
			name: 'Ann',
			kind: 'staff',
			active: true,
			admin: true,
			team: null,
			last_seen: null
		}
	],
	teams: [{ id: 'ops', name: 'Ops' }],
	invitations: [
		{
			id: 'i1',
			email: 'b@example.test',
			phone: null,
			team: null,
			external: false,
			status: 'open',
			expires_at: '2026-01-01T00:00:00Z'
		}
	],
	keys: [
		{
			id: 'k1',
			name: 'CI',
			prefix: 'nb_',
			team: null,
			created_by: 'u1',
			created_at: '2026-01-01',
			revoked_at: null,
			last_used_at: null
		}
	],
	policies: ['admin'],
	secrets: [{ name: 'TOKEN', label: 'Token', set: null }],
	envoys: [
		{
			id: 'e1',
			name: 'Helper',
			audience: 'public',
			task: '',
			policies: [],
			groupMessages: 'mention_or_reply',
			delegation: 'enabled',
			triage: false,
			dm: 'envoy',
			active: true,
			created: false
		}
	],
	instances: [
		{
			id: 'n1',
			name: 'Mail',
			integration: 'mail',
			owner: null,
			named: true,
			envoy: null,
			active: true,
			status: { state: 'ready' },
			configuration: { from: 'a@example.test' },
			delivery: {
				sent: 1,
				pending: 0,
				retrying: 0,
				failed: 0,
				skipped: 0,
				nextRetry: null,
				lastError: null
			}
		}
	],
	mcp: [{ name: 'docs', url: 'https://docs.example.test' }],
	audit: [
		{
			model: 'sys_user',
			record: 'u1',
			revision: 1,
			at: '2026-01-01',
			actor: null,
			op: 'create',
			changes: { name: 'Ann' }
		}
	],
	integrations: [
		{
			name: 'mail',
			driver: 'email',
			description: 'Mail',
			conversation: true,
			personal: false,
			sends: true,
			syncs: false,
			configuration: { from: { kind: 'text', format: 'email' } }
		}
	],
	signup: { via: ['email'], open: true }
} satisfies Settings;

const line = { at: '2026-01-01T00:00:00Z', level: 'warn', message: 'slow' } as const;
const diagnostic = {
	code: 'model/x',
	path: 'src/a.ts',
	line: 3,
	message: 'Bad',
	help: 'Fix it',
	severity: 'warn'
} as const;
const build = {
	commit: 'c1',
	at: '2026-01-01',
	status: 'built',
	message: 'ok',
	deployed: true,
	live: true,
	lines: 3,
	diagnostics: 1
} as const;
const preview = {
	url: null,
	commit: 'c1',
	artifact: 'a1',
	stale: false,
	shelved: true,
	destructive: ['drop x'],
	impact: { durationMs: 5, steps: [{ id: 's', hazard: 'drop', rows: 1, summary: 'Drops x' }] }
} as const;
const entries = [{ name: 'crm', path: 'src/app/crm/+app.ts', href: '/app/crm' }];
const studio = {
	commit: 'c1',
	message: 'Edit',
	zone: 'UTC',
	files: { 'src/a.ts': { bytes: 10 } },
	changes: [{ path: 'src/a.ts', change: 'modified', text: 'b', baseline: 'a' }],
	log: [line],
	preview: 'https://preview.example.test',
	releases: [
		{
			commit: 'c0',
			at: '2026-01-01',
			message: 'First',
			current: true,
			checkpoint: null,
			rollback: 'c-1',
			undo: true,
			discards: '2026-01-02',
			replaced: true
		}
	],
	environments: [{ name: 'live', release: 'r1', url: null }],
	change: 'ch1',
	branch: 'change/ch1',
	previewOf: preview,
	previewControl: { holder: 'norbius', conversation: 'conv', at: '2026-01-01' },
	base: 'c0',
	behind: 1,
	conflicts: ['src/b.ts'],
	changeSets: [
		{
			id: 'ch1',
			title: 'Edit',
			state: 'open',
			openedBy: 'u1',
			contributors: ['u1'],
			branch: 'change/ch1',
			base: 'c0',
			head: 'c1',
			behind: 0,
			preview,
			merge: {
				state: 'failed',
				at: '2026-01-01',
				head: 'c1',
				error: 'conflict',
				runAt: '2026-01-02'
			},
			log: [line],
			createdAt: '2026-01-01',
			updatedAt: '2026-01-01',
			diagnostics: [diagnostic]
		}
	],
	diagnostics: [diagnostic],
	builds: [build],
	approvals: [
		{
			id: 'ap1',
			op: { op: 'change.merge', id: 'ch1', accept: ['drop x'], at: '2026-01-02' },
			requestor: 'u1',
			conversation: 'conv',
			at: '2026-01-01',
			head: 'c1',
			destructive: ['drop x']
		}
	],
	sections: {
		models: [],
		apps: entries,
		kiosks: [],
		policies: [],
		automations: [],
		remotes: [],
		secrets: []
	},
	stale: true
} satisfies StudioView;
const record = { build, log: [line], diagnostics: [diagnostic] } satisfies StudioBuildRecord;
const files = [
	{ text: 'x', truncated: { limit: 1, bytes: 2 } },
	{ binary: true, bytes: 4 }
] satisfies StudioFile[];
const rules = {
	revision: 1,
	ruleSet: { states: { r1: 'off' }, ignore: ['dist'], rules: [{ id: 'own' }] },
	rules: [
		{
			id: 'r1',
			pack: 'platform',
			summary: 'Rule',
			severity: 'hint',
			state: 'off',
			principles: ['p'],
			files: ['src/**'],
			rationale: 'Why',
			examples: { bad: ['a'], good: ['b'] }
		}
	],
	errors: [{ id: 'own', message: 'Bad rule' }],
	digest: 'd',
	version: 'v'
} satisfies StudioAuditRules;
const audit = {
	commit: 'c1',
	findings: [
		{ rule: 'r1', severity: 'error', summary: 'Rule', location: 'a.ts:1: x', principles: [] }
	],
	errors: [],
	digest: 'd',
	version: 'v'
} satisfies StudioAudit;

describe('shell answers', () => {
	it('decode every key their types carry', () => {
		strict(ShellBootAnswer, boot);
		strict(SettingsAnswer, settings);
		strict(StudioViewAnswer, studio);
		strict(StudioBuildAnswer, record);
		strict(StudioBuildAnswer, null);
		for (const file of files) strict(StudioFileAnswer, file);
		strict(StudioAuditRulesAnswer, rules);
		strict(StudioAuditAnswer, audit);
	});
	it.effect('refuse a malformed answer as a protocol failure', () =>
		Effect.gen(function* () {
			const answering = (value: unknown) =>
				shellApi(async () => Response.json({ value }), { base: 'http://localhost' });
			const protocol = { status: 200, code: 'protocol' };
			expect(yield* Effect.flip(answering({ ...boot, nav: {} }).boot())).toMatchObject(protocol);
			expect(yield* Effect.flip(answering({ contract: 'x' }).boot())).toMatchObject(protocol);
			expect(
				yield* Effect.flip(answering({ ...settings, members: null }).settings())
			).toMatchObject(protocol);
			expect(yield* Effect.flip(answering({ ...studio, files: [] }).studio())).toMatchObject(
				protocol
			);
			expect(
				yield* Effect.flip(answering({ binary: false }).studioFile('c1', 'src/a.ts'))
			).toMatchObject(protocol);
			expect(yield* Effect.flip(answering({ build }).studioBuild('c1'))).toMatchObject(protocol);
			expect(
				yield* Effect.flip(answering({ ...rules, rules: {} }).studioAuditRules())
			).toMatchObject(protocol);
		})
	);
});
