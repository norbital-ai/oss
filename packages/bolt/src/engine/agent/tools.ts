// The agent catalogue coordinator: binds native tools, file/source tools, run_js, sub-agents,
// MCP servers and host tools under the current actor and audience.
import { Effect, Option, Result, Schema } from 'effect';
import { Port, SKILL_FILE } from '@norbital-ai/host-api';
import type { Json } from '../../decl/values.ts';
import { SYSTEM_UI, SystemUiRequest, systemUiPath } from '../../protocol/system-ui.ts';
import { nav, navigation_paths } from '../../shell/nav.ts';
import { readsAny } from '../access/authority.ts';
import { confirmed_send } from '../conversations/status.ts';
import type { EngineError } from '../errors.ts';
import { layered } from '../manifest.ts';
import { row as systemRow } from '../system/rows.ts';
import { ToolAnswer } from './ai.ts';
import { BOUNDS, filesOf, size } from './context.ts';
import { isList, isObj } from './draft.ts';
import { ambient, authorOf } from './schema.ts';
import {
	actTool,
	agentReadTool,
	connectTool,
	decideTool,
	describeTool,
	fixedTools,
	geocodeTool,
	historyTool,
	inviteTool,
	offers,
	pageTool,
	readMessagesTool,
	runAutomationTool,
	runToolTool,
	skillTool,
	syncTool,
	updatePlanTool
} from './tools/definitions.ts';
import { bindFileTools, canRead, inputOfFile, sourceFile } from './tools/files.ts';
import {
	callablesFor,
	decodeView,
	documentAnswer,
	err,
	guard,
	ok,
	readPaths,
	receipt,
	requestId,
	section,
	skillOf,
	sweeping,
	textAnswer
} from './tools/helpers.ts';
import { bindContributedTools } from './tools/host.ts';
import { jobFailed } from './tools/jobs.ts';
import {
	catalogueIndex,
	describeWorkspace,
	ledgerRoots,
	messageCatalogue,
	readTool,
	withExtras
} from './tools/read.ts';
import { bindRuntimeTools } from './tools/runtime.ts';
import { bindSourceTools, visibleSource } from './tools/source.ts';
import {
	APPROVE,
	AUTOMATION,
	CLOSED,
	REJECTED,
	TOOLS_PER_REQUEST,
	ToolRejected,
	type AddTool,
	type BoundTool,
	type Catalogue,
	type CatalogueIndex,
	type HoldTool,
	type HostGives,
	type ToolContext
} from './tools/types.ts';
import { connectionOf, connectionRow, perform, runJob } from './tools/write.ts';

export { ToolAnswer } from './ai.ts';
export { JOBS, jobs } from './tools/jobs.ts';
export {
	CLOSED,
	Decide,
	InviteInput,
	OVERVIEW_BYTES,
	RunInput,
	TEXT_FIRST_BYTES,
	ToolJson,
	TOOLS_PER_REQUEST,
	WriteInput,
	type AgentTool,
	type AttachmentPort,
	type Audience,
	type Catalogue,
	type CatalogueIndex,
	type ReadToolContext,
	type Skill,
	type SourceSearch,
	type ToolContext,
	type Validators
} from './tools/types.ts';
export { fixedTools } from './tools/definitions.ts';
export { globRegExp, readOutputs, readPaths, sweeping, turnFacts } from './tools/helpers.ts';
export {
	catalogueNote,
	describeWorkspace,
	messageCatalogue,
	readInferTool,
	readTool
} from './tools/read.ts';
export { connectionFact, perform, performed, runJob } from './tools/write.ts';

const InstanceRow = systemRow('sys_integration', ['id']);

/** The actor may change at a steer, so a step binds every handler under its admitted authority. */
export const catalogue = Effect.fn('AgentTool.catalogue')(function* (x: ToolContext) {
	const e = x.engine,
		a = x.authority,
		acts = callablesFor(e.manifest, a, x.inApp && !x.child && e.identity !== undefined),
		agent = x.mode === 'agent',
		staff = a.actor.kind === 'member' && !a.actor.external,
		has: HostGives = { source: (x.draft ?? x.workspace) !== undefined, delegation: x.delegation };
	const entries = new Map<string, BoundTool>(),
		mcpEntries = new Map<string, BoundTool>();

	const add: AddTool = (definition, handler, meta = {}, destination = entries) => {
		if (!offers(definition, x.audience, x.child, has)) return;
		const { name, description, input, behavior } = definition;
		const { view, ...shown } = meta;
		destination.set(name, {
			tool: { name, description, input, behavior, ...shown },
			...(view === undefined ? {} : { view }),
			scripts: definition.scripts !== false,
			run: (given, callId) =>
				definition.decode(given, { ...CLOSED, errors: 'all' }).pipe(
					Effect.mapError(
						(error) => new Error(`Invalid parameters for tool '${name}': ${error.message}`)
					),
					Effect.tap((decoded) => Effect.annotateCurrentSpan({ tool: name, parameters: decoded })),
					Effect.flatMap((decoded) => guard(Effect.gen(() => handler(decoded, callId))))
				)
		});
	};

	const hold: HoldTool = (name, input, what) =>
		a.actor.kind === 'envoy'
			? err(
					`An envoy cannot ${what}: that needs a person's confirmation in the app, and this chat has no card. Say so.`
				)
			: a.actor.kind !== 'member' || x.approved(name, input)
				? undefined
				: { confirm: true };

	const read = readTool(x);
	const ledgers = ledgerRoots(x);
	if (read !== undefined || Object.keys(ledgers).length > 0)
		add(agentReadTool, function* ({ request }, call) {
			const roots = Object.entries(request);
			const ledger = roots.filter(([root]) => root.startsWith('$'));
			const asked = Object.fromEntries(
				roots
					.filter(([root]) => !root.startsWith('$'))
					.map(([root, node]) => {
						const { history: _history, approvals: _approvals, ...rest } = node;
						return [root, rest];
					})
			);
			const extras = Object.fromEntries(
				roots.flatMap(([root, node]) =>
					!root.startsWith('$') &&
					!root.includes('.') &&
					(node['history'] === true || node['approvals'] === true)
						? [
								[
									root,
									{
										history: node['history'] === true,
										approvals: node['approvals'] === true,
										output: typeof node['output'] === 'string' ? node['output'] : undefined
									}
								] as const
							]
						: []
				)
			);
			const unknown = ledger.find(([root]) => ledgers[root] === undefined);
			if (unknown !== undefined)
				return err(
					`No '${unknown[0]}' you may read. Ledgers: ${Object.keys(ledgers).join(', ') || 'none'}`
				);
			const records =
				Object.keys(asked).length === 0
					? undefined
					: read === undefined
						? err('You read no models.')
						: yield* read.run({ request: asked }, (full) => withExtras(x, full, extras));
			const answers = yield* Effect.forEach(ledger, ([root, node]) =>
				Effect.map(
					ledgers[root]?.(node, call) ?? Effect.succeed<ToolAnswer>(err(`No '${root}'.`)),
					(answer) => [root, answer] as const
				)
			);
			if (records === undefined && answers.length === 1 && answers[0] !== undefined)
				return answers[0][1];
			const failed = [records, ...answers.map(([, answer]) => answer)].find(
				(answer) => answer !== undefined && 'result' in answer && jobFailed(answer.result) !== undefined
			);
			if (failed !== undefined) return failed;
			const part = (answer: ToolAnswer | undefined, key: 'result' | 'full'): Json =>
				answer === undefined || !('result' in answer)
					? null
					: key === 'full' && answer.full !== undefined
						? answer.full
						: answer.result;
			const merge = (key: 'result' | 'full'): Json => {
				const base = part(records, key);
				return {
					...(isObj(base) ? base : {}),
					...Object.fromEntries(answers.map(([root, answer]) => [root, part(answer, key)]))
				};
			};
			return { result: merge('result'), full: merge('full'), bounded: true };
		});

	add(describeTool, function* (i) {
		const names = i.names ?? [];
		const setup = !names.includes('system')
			? undefined
			: !x.inApp || x.child || !a.admin || a.actor.kind !== 'member' || a.actor.external
				? 'system: nothing you may set up.'
				: yield* Effect.map(
						x.engine.db.read([
							{
								text: 'SELECT id, name, integration, envoy FROM sys_integration ORDER BY name',
								params: []
							},
							{
								text: 'SELECT id, name, audience, policies, active FROM sys_envoy ORDER BY name',
								params: []
							}
						]),
						([connected, envoys]) =>
							[
								'# System',
								`capabilities (page { path, configure }): ${Object.entries(SYSTEM_UI)
									.map(([capability, ui]) => `${capability} ${JSON.stringify(ui)}`)
									.join('; ')}`,
								`connections: ${JSON.stringify(connected?.rows ?? [])}`,
								`envoys: ${JSON.stringify(envoys?.rows ?? [])}`,
								`secrets: ${Object.keys(e.manifest.workspace.secrets ?? {}).join(', ') || 'none'}`,
								`mcp: ${Object.keys(e.manifest.mcp).join(', ') || 'none'}`
							].join('\n')
					);
		if (setup !== undefined && names.length === 1) return ok(setup);
		const workspace = x.workspace;
		const source =
			workspace === undefined
				? null
				: yield* Port.attempt('workspace', () => workspace.read('src/i18n/+messages.ts')).pipe(
						Effect.orElseSucceed(() => null)
					);
		const roots =
			names.length > 0 ? [] : readPaths(e.manifest, a).filter((path) => !path.includes('.'));
		const counted =
			roots.length === 0 || read === undefined
				? undefined
				: yield* read.run({
						request: Object.fromEntries(roots.map((root) => [root, { limit: 1 }]))
					});
		const whole =
			counted === undefined || !('result' in counted)
				? undefined
				: 'full' in counted
					? counted.full
					: counted.result;
		const totals = new Map(
			roots.flatMap((root) => {
				const total = isObj(whole) && isObj(whole[root]) ? whole[root]['total'] : undefined;
				return typeof total === 'number' ? [[root, total] as const] : [];
			})
		);
		const described = describeWorkspace(
			e.manifest,
			a,
			messageCatalogue(source),
			names.filter((name) => name !== 'system'),
			totals
		);
		return ok(setup === undefined ? described : `${described}\n\n${setup}`);
	});

	if (
		agent &&
		x.inApp &&
		!x.child &&
		x.conv.owner !== null &&
		x.conv.integration === null &&
		x.conv.envoy === null &&
		x.conv.run == null &&
		staff
	) {
		const allowed = navigation_paths(nav(e.manifest, a), a.admin);
		add(
			pageTool,
			function* (given) {
				const { path, configure: asked, click, type, scroll, go, highlight, preview } = given;
				if (preview !== undefined) {
					if (!(/^https?:\/\//.test(preview) && URL.canParse(preview)))
						return err('preview is a preview URL (https://…)');
					const held = hold('page', given, 'control their open tab');
					if (held !== undefined) return held;
					return ok({ preview });
				}
				if (path !== undefined) {
					if (!allowed.includes(path))
						return err(`No page ${path}. Pages: ${allowed.join(', ')}`);
					const setup = Schema.decodeUnknownOption(SystemUiRequest)(asked);
					if (asked !== undefined && Option.isNone(setup))
						return err(
							"configure is a capability from describe_workspace { names: ['system'] }"
						);
					const configure = Option.getOrUndefined(setup);
					if (
						configure?.capability === 'secret.set' &&
						e.manifest.workspace.secrets?.[configure.record] === undefined
					)
						return err('That secret is not declared in this workspace.');
					if (
						configure?.capability === 'mcp.configure' &&
						e.manifest.mcp[configure.record] === undefined
					)
						return err('That MCP server is not declared in this workspace.');
					const target =
						configure === undefined ? path : a.admin ? systemUiPath(path, configure) : null;
					if (target === null)
						return err('This configuration does not belong to that page or your authority.');
					const held = hold('page', given, 'control their open tab');
					if (held !== undefined) return held;
					return ok({ navigation: target, requested: true });
				}
				if ([click, scroll, go, type, highlight].every((v) => v === undefined))
					return err('give path, click, type, scroll, go, highlight or preview');
				const held = hold('page', given, 'control their open tab');
				if (held !== undefined) return held;
				return ok({
					page: {
						...(click === undefined ? {} : { click }),
						...(scroll === undefined ? {} : { scroll }),
						...(go === undefined ? {} : { go }),
						...(type === undefined ? {} : { type }),
						...(highlight === undefined ? {} : { highlight })
					},
					requested: true
				});
			}
		);
	}

	const sync_controls =
		a.actor.kind !== 'member'
			? []
			: Object.entries(e.manifest.exposures).flatMap(([model, spec]) =>
					Object.entries(spec.syncs ?? {}).flatMap(([sync, entry]) => {
						if (entry.with === 'file') {
							const grants = a.models[model];
							const modes = [
								...(a.admin || (grants?.create.length ?? 0) + (grants?.update.length ?? 0) > 0
									? ['import']
									: []),
								...(readsAny(a, model) ? ['template', 'export'] : [])
							];
							return modes.length === 0 ? [] : [{ model, sync, kind: 'file', modes }];
						}
						return entry.read === true &&
							readsAny(a, model) &&
							(a.admin || a.capabilities.syncs.includes(`${model}.${sync}`))
							? [{ model, sync, kind: 'remote', modes: ['read'] }]
							: [];
					})
				);

	const withFileRefs = Effect.fn('AgentTool.fileRefs')(function* (callable: string, input: Json) {
		const dot = callable.lastIndexOf('.'),
			model = callable.slice(0, dot),
			verb = callable.slice(dot + 1),
			fields = e.manifest.models[model]?.fields ?? {};
		const files = Object.keys(fields).filter((f) => fields[f]?.kind === 'file');
		if (files.length === 0 || !['create', 'update', 'import'].includes(verb)) return input;
		const ref = Effect.fn('AgentTool.fileRef')(function* (given: Json) {
			const named = isObj(given) && typeof given['id'] === 'string' ? given['id'] : given;
			if (typeof named !== 'string') return given;
			const [file] = yield* sourceFile(x, named);
			if (file === undefined || !(yield* canRead(x, file.id)))
				return `No file ${named} you can read.`;
			return { id: file.id, name: file.name, mime: file.mime, size: file.size };
		});
		const row: (r: Json) => Effect.Effect<Json, EngineError> = Effect.fn('AgentTool.fileRow')(
			function* (r: Json) {
				if (!isObj(r)) return r;
				const out: { [key: string]: Json } = { ...r };
				for (const f of files) {
					const v = r[f];
					if (v === undefined) continue;
					const refs = yield* Effect.forEach(isList(v) ? v : [v], ref);
					const missing = refs.find((one) => typeof one === 'string');
					if (missing !== undefined) return missing;
					out[f] = isList(v) ? refs : (refs[0] ?? null);
				}
				if (verb === 'update' && isObj(r['set'])) {
					const set = yield* row(r['set']);
					if (typeof set === 'string') return set;
					out['set'] = set;
				}
				return out;
			}
		);
		const rows =
			verb === 'import' && isObj(input) && isList(input['rows'])
				? input['rows']
				: isList(input)
					? input
					: [];
		const done = yield* Effect.forEach(rows, row);
		const missing = done.find((one) => typeof one === 'string');
		if (missing !== undefined) return missing;
		return verb === 'import' && isObj(input) ? { ...input, rows: done } : done;
	});

	const automations = a.automations.filter(
		(n) => e.manifest.automations[n] !== undefined && e.manifest.automations[n]?.agent !== 'never'
	);

	if (agent && acts.size > 0)
		add(actTool, function* (i, id) {
			if (i.acts !== undefined && i.input_file !== undefined)
				return err('Give acts or input_file, not both.');
			if (typeof i.input_file === 'string') {
				const loaded = yield* inputOfFile(x, i.input_file);
				if ('error' in loaded) return err(loaded.error);
				if (!isObj(loaded.input)) return err('The input file must contain an act map.');
				i = { acts: loaded.input, ...(i.key === undefined ? {} : { key: i.key }) };
			}
			const list = Object.entries(i.acts ?? {});
			if (list.length === 0) return err('An act needs a non-empty map of generated writes.');
			const inputs: Record<string, Json> = {};
			for (const [callable, input] of list) {
				if (!acts.has(callable) || callable === APPROVE || callable === 'sys_invitation.create')
					return err(
						`You may not write '${callable}'. Read describe_workspace for your generated writes.`
					);
				if (isList(input) && input.length === 0)
					return err(`'${callable}' was given no rows: there is nothing to write.`);
				const filed = yield* withFileRefs(callable, input);
				if (typeof filed === 'string') return err(filed);
				inputs[callable] = filed;
			}
			const prepared = { acts: inputs, ...(i.key === undefined ? {} : { key: i.key }) };
			const mutations = list.filter(
				([callable, input]) =>
					!(callable.endsWith('.import') && isObj(input) && input['dry_run'] === true)
			);
			const sweep =
				mutations.length > 1 || mutations.some(([callable, input]) => sweeping(callable, input));
			if (a.actor.kind === 'envoy' && sweep)
				return err(
					"An envoy cannot delete or write a batch: that needs a person's confirmation in the app, and this chat has no card. Say so."
				);
			if (
				x.inApp &&
				(list.some(([callable]) => acts.get(callable)?.confirm === true) ||
					(sweep && a.actor.kind === 'member'))
			)
				return { confirm: true, input: prepared } as const;
			return ok(yield* perform(x, 'act', prepared, id));
		});

	if (agent && automations.length > 0)
		add(runAutomationTool, function* (i, id) {
			if (!automations.includes(i.automation))
				return err(`You may not run '${i.automation}'. Yours: ${automations.join(', ')}`);
			if (i.input !== undefined && i.input_file !== undefined)
				return err('Give input or input_file, not both.');
			if (i.input_file !== undefined) {
				const loaded = yield* inputOfFile(x, i.input_file);
				if ('error' in loaded) return err(loaded.error);
				i = {
					automation: i.automation,
					input: loaded.input,
					...(i.key === undefined ? {} : { key: i.key })
				};
			}
			if (a.actor.kind === 'envoy')
				return err(
					"An envoy cannot start an automation: that needs a person's confirmation in the app, and this chat has no card. Say so."
				);
			if (x.inApp) return { confirm: true, input: i } as const;
			const answer = yield* perform(x, 'run', i, id);
			return ok(yield* runJob(x.jobs, e, a, `${AUTOMATION}.${i.automation}`, answer));
		});

	if (agent && acts.has(APPROVE))
		add(decideTool, function* (i, id) {
			if (x.inApp) return { confirm: true } as const;
			return ok(yield* perform(x, 'decide', i, id));
		});

	if (agent && acts.has('sys_invitation.create'))
		add(inviteTool, function* () {
			return { confirm: true } as const;
		});

	const me = a.actor.kind === 'member' ? a.actor.id : null;
	if (agent && x.inApp && !x.child && me !== null)
		add(connectTool, function* (i, id) {
			const held = (instance: string, integration: string) =>
				({ confirm: true, input: { instance, integration } }) as const;
			const existing =
				i.instance ??
				(i.envoy === undefined || i.integration === undefined
					? undefined
					: (yield* e.db.rows(InstanceRow, {
							text: 'SELECT id FROM sys_integration WHERE envoy = $1 AND integration = $2 ORDER BY id LIMIT 1',
							params: [i.envoy, i.integration]
						}))[0]?.id);
			if (existing !== undefined) {
				const row = yield* connectionRow(e, existing);
				if (row === undefined) return err(`No connection '${existing}'.`);
				if (row.owner !== null && row.owner !== me)
					return err('Only its owner pairs a personal connection.');
				if (row.owner === null && !acts.has('sys_integration.update'))
					return err('You may not manage workspace connections.');
				const fact = connectionOf(row);
				return fact.state === 'connected' ? ok(fact) : held(row.id, row.integration);
			}
			if (i.integration === undefined || i.owner === undefined)
				return err('give integration and owner (me or workspace), or instance');
			const definitions = layered(e.manifest).integrations;
			if (!Object.hasOwn(definitions, i.integration))
				return err(
					`No integration '${i.integration}'. Integrations: ${Object.keys(definitions).join(', ')}`
				);
			const answer = yield* perform(
				x,
				'act',
				{
					acts: {
						'sys_integration.create': [
							{
								integration: i.integration,
								name: i.name ?? i.integration,
								...(i.owner === 'me' ? { owner: me } : {}),
								...(i.envoy === undefined ? {} : { envoy: i.envoy }),
								...(i.configuration === undefined ? {} : { configuration: i.configuration })
							}
						]
					}
				},
				id
			);
			const made =
				isObj(answer) && answer['kind'] === 'committed' && isList(answer['records'])
					? answer['records'].find((r) => isObj(r) && r['model'] === 'sys_integration')
					: undefined;
			return isObj(made) && typeof made['id'] === 'string'
				? held(made['id'], i.integration)
				: ok(answer);
		});

	if (agent && sync_controls.length > 0)
		add(syncTool, function* (i, id) {
			if (!sync_controls.some((entry) => entry.model === i.model && entry.sync === i.sync))
				return err(
					'You may not use this sync. Read describe_workspace for your native sync controls.'
				);
			const automation = `${i.model}.sync.${i.sync}`,
				input = i.input ?? {};
			const run = requestId(x, id, i.key);
			const outcome = yield* e.calls.sync_control({
				model: i.model,
				sync: i.sync,
				id: run,
				input,
				authority: a,
				bindings: x.bindings,
				...(x.inApp ? { agent: { conversation: x.conv.id } } : {})
			});
			receipt(x.receipts, automation, outcome);
			return ok(yield* runJob(x.jobs, e, a, automation, { run, outcome }));
		});

	if (x.mode === 'plan') {
		add(updatePlanTool, function* (i) {
			const plan = x.conv.plan,
				rev = plan?.revision ?? 0;
			if (i.expected_revision !== undefined && i.expected_revision !== rev)
				return err(`The plan is at revision ${rev}; read it again before editing.`);
			if (typeof i.body === 'string') {
				yield* x.setPlan(i.body);
				return ok({ saved: true, revision: rev + 1 });
			}
			const p = i.patch;
			if (p?.old === undefined || plan === null)
				return err('Give body, or a patch against an existing plan.');
			const count = plan.body.split(p.old).length - 1;
			if (count !== 1)
				return err(
					count === 0
						? 'That passage is not in the plan.'
						: 'That passage occurs more than once; quote more of it.'
				);
			yield* x.setPlan(plan.body.replace(p.old, p.new ?? ''));
			return ok({ saved: true, revision: rev + 1 });
		});
	}

	const skills = Object.entries(x.skills);
	if (skills.length > 0) {
		type SkillReq = {
			readonly name: string;
			readonly section?: string | undefined;
			readonly sections?: readonly string[] | undefined;
			readonly file?: string | undefined;
			readonly files?: readonly string[] | undefined;
		};
		const readOneSkill = Effect.fn('AgentTool.skillOne')(function* (req: SkillReq) {
			const t = skills.find(([n]) => n === req.name)?.[1];
			if (t === undefined)
				return err(`No skill '${req.name}'. Skills: ${skills.map(([n]) => n).join(', ')}`);
			const modes = [
				req.file !== undefined,
				req.files !== undefined,
				req.section !== undefined,
				req.sections !== undefined
			].filter(Boolean).length;
			if (modes > 1) return err('Give only one of section, sections, file, or files.');
			const s = skillOf(t.text);
			const own = t.files.filter(
				(f) => f !== SKILL_FILE && !f.split('/').includes('node_modules')
			);
			const resolveSkillFile = (requested: string): string | undefined => {
				if (t.files.includes(requested)) return requested;
				const needle = requested.trim().toLowerCase();
				return own.find(
					(f) =>
						f.toLowerCase() === needle ||
						f.toLowerCase() === `references/${needle}` ||
						f.toLowerCase() === `references/${needle}.md` ||
						f.toLowerCase() === `${needle}.md`
				);
			};
			if (req.files !== undefined) {
				const unique = [...new Set(req.files)];
				if (unique.length === 0)
					return err(
						`Give at least one file in ${req.name}. Files: ${own.slice(0, 50).join(', ')}`
					);
				const resolved: string[] = [];
				const missing: string[] = [];
				for (const requested of unique) {
					const found = resolveSkillFile(requested);
					if (found === undefined || found === SKILL_FILE) missing.push(requested);
					else resolved.push(found);
				}
				if (resolved.length === 0)
					return err(
						`No file(s) ${missing.map((f) => `'${f}'`).join(', ')} in ${req.name}. Files: ${own.slice(0, 50).join(', ')}`
					);
				const decoder = new TextDecoder();
				const loaded = yield* Effect.forEach(
					resolved,
					(file) =>
						t.read(file).pipe(Effect.map((bytes) => ({ file, text: decoder.decode(bytes) }))),
					{ concurrency: 'unbounded' }
				);
				return documentAnswer(
					{
						skill: req.name,
						files: loaded.map(({ file }) => file),
						...(missing.length === 0
							? {}
							: {
									missing,
									available: own.slice(0, 50)
								}),
						text: loaded.map(({ file, text }) => `<!-- ${file} -->\n${text}`).join('\n\n')
					},
					'text'
				);
			}
			if (req.file !== undefined && req.file !== SKILL_FILE) {
				const found = resolveSkillFile(req.file);
				if (found === undefined || found === SKILL_FILE)
					return err(
						`No file '${req.file}' in ${req.name}. Files: ${own.slice(0, 50).join(', ')}`
					);
				const bytes = yield* t.read(found);
				return documentAnswer({ file: found, text: new TextDecoder().decode(bytes) }, 'text');
			}
			const files = own.length === 0 ? {} : { files: own.slice(0, 50) };
			if (req.sections !== undefined) {
				const unique = [...new Set(req.sections)];
				if (unique.length === 0)
					return err(`Give at least one section in ${req.name}. Sections: ${s.sections.join(', ')}`);
				const decoder = new TextDecoder();
				const foundParts: { readonly key: string; readonly text: string }[] = [];
				const missing: string[] = [];
				for (const asked of unique) {
					const part = section(s.body, asked);
					if (part !== undefined) {
						foundParts.push({ key: asked, text: part });
						continue;
					}
					const refFile = resolveSkillFile(asked);
					if (refFile !== undefined && refFile !== SKILL_FILE) {
						const bytes = yield* t.read(refFile);
						foundParts.push({ key: refFile, text: decoder.decode(bytes) });
					} else missing.push(asked);
				}
				if (foundParts.length === 0)
					return ok({
						error: `No section(s) ${missing.map((m) => `'${m}'`).join(', ')} in ${req.name}.`,
						sections: s.sections,
						...files
					});
				return documentAnswer(
					{
						skill: req.name,
						sections: foundParts.map((p) => p.key),
						...(missing.length === 0 ? {} : { missing, available: s.sections }),
						text: foundParts.map((p) => `<!-- ${p.key} -->\n${p.text}`).join('\n\n')
					},
					'text'
				);
			}
			if (req.section === undefined) {
				const parts = s.body.split(/^(?=##\s)/m);
				let body = '',
					shown = 0;
				for (const part of parts) {
					if (shown > 0 && size(body + part) > BOUNDS.resultBytes - 2000) break;
					body += part;
					shown++;
				}
				const rest = parts
					.slice(shown)
					.map((p) => /^##\s+(.+)$/m.exec(p)?.[1]?.trim())
					.filter((name): name is string => name !== undefined);
				return documentAnswer(
					{
						description: s.description,
						sections: s.sections,
						body,
						...files,
						...(rest.length === 0 ? {} : { more: `read each with section: ${rest.join(', ')}` })
					},
					'body'
				);
			}
			const part = section(s.body, req.section);
			if (part !== undefined) return textAnswer(part);
			const refFile = resolveSkillFile(req.section);
			if (refFile !== undefined && refFile !== SKILL_FILE) {
				const bytes = yield* t.read(refFile);
				return documentAnswer({ file: refFile, text: new TextDecoder().decode(bytes) }, 'text');
			}
			return ok({ error: `No section '${req.section}'.`, sections: s.sections, ...files });
		});

		add(skillTool, function* (i) {
			if (i.requests !== undefined) {
				if (
					i.name !== undefined ||
					i.section !== undefined ||
					i.sections !== undefined ||
					i.file !== undefined ||
					i.files !== undefined
				)
					return err('Give either requests or name (not both).');
				if (i.requests.length === 0)
					return err(`Give at least one skill request. Skills: ${skills.map(([n]) => n).join(', ')}`);
				if (i.requests.length === 1 && i.requests[0] !== undefined)
					return yield* readOneSkill(i.requests[0]);
				const answers = yield* Effect.forEach(
					i.requests,
					(req) =>
						readOneSkill(req).pipe(Effect.map((answer) => ({ req, answer }))),
					{ concurrency: 'unbounded' }
				);
				const blocks: string[] = [];
				const items: Json[] = [];
				for (const { req, answer } of answers) {
					const payload =
						'result' in answer
							? 'full' in answer && answer.full !== undefined
								? answer.full
								: answer.result
							: null;
					if (typeof payload === 'string') {
						items.push({ skill: req.name, ok: true });
						blocks.push(`<!-- skill:${req.name}${req.section ? `#${req.section}` : ''} -->\n${payload}`);
					} else if (isObj(payload) && typeof payload['error'] === 'string') {
						items.push({ skill: req.name, error: payload['error'] });
					} else if (isObj(payload)) {
						const content =
							typeof payload['text'] === 'string'
								? payload['text']
								: typeof payload['body'] === 'string'
									? payload['body']
									: JSON.stringify(payload);
						items.push({
							skill: req.name,
							ok: true,
							...(Array.isArray(payload['files']) ? { files: payload['files'] } : {}),
							...(Array.isArray(payload['sections']) ? { sections: payload['sections'] } : {}),
							...(Array.isArray(payload['missing']) ? { missing: payload['missing'] } : {})
						});
						blocks.push(`<!-- skill:${req.name} -->\n${content}`);
					}
				}
				return documentAnswer({ items, text: blocks.join('\n\n') }, 'text');
			}
			if (i.name === undefined)
				return err(`Give name or requests. Skills: ${skills.map(([n]) => n).join(', ')}`);
			return yield* readOneSkill({
				name: i.name,
				section: i.section,
				sections: i.sections,
				file: i.file,
				files: i.files
			});
		});
	}

	add(historyTool, function* (i) {
		return ok(
			yield* x.history(
				i.query,
				i.scope === 'mine' ? 'mine' : 'this',
				Math.max(1, Math.min(i.limit ?? 20, 50))
			)
		);
	});

	if (x.conv.integration !== null) {
		add(readMessagesTool, function* (i) {
			const rows = yield* x.messages({
				limit: Math.max(1, Math.min(i.limit ?? 50, 50)),
				...(i.before === undefined ? {} : { before: i.before })
			});
			return ok({
				messages: rows.map((r) => ({
					seq: r.seq,
					from: r.role === 'assistant' ? 'you' : authorOf(r),
					sender: r.sender ?? null,
					message: r.provider_id ?? null,
					status: r.status ?? null,
					sent:
						r.direction === 'outbound' && !confirmed_send(r.status) ? null : (r.sent_at ?? null),
					created: r.created_at ?? null,
					text: r.text,
					files: filesOf(r),
					addressed: !ambient(r)
				}))
			});
		});
	}

	bindFileTools(x, add, hold, agent, staff);

	if (x.geocoder !== undefined) {
		add(geocodeTool, function* (i) {
			const geo = x.geocoder;
			if (geo === undefined) return err('The geocoder is not available here.');
			const r =
				i.reverse === undefined
					? yield* geo.search(i.query ?? '')
					: yield* geo.reverse(i.reverse).pipe(Effect.map((hit) => (hit === null ? [] : [hit])));
			return ok(
				r.slice(0, 8).map((hit) => ({ label: hit.label, address: hit.address, location: hit.point }))
			);
		});
	}

	const source = visibleSource(x);
	bindSourceTools(x, source, add);

	let self: Catalogue['run'] | undefined;
	bindRuntimeTools(x, add, hold, {
		agent,
		staff,
		source,
		skills,
		entries,
		mcpEntries,
		getSelf: () => self
	});

	const encodeAnswer = Schema.encodeUnknownEffect(ToolAnswer);
	const execute = (
		registry: ReadonlyMap<string, BoundTool>,
		name: string,
		input: unknown,
		callId: string
	) => {
		const entry = registry.get(name);
		if (entry === undefined)
			return Effect.succeed(
				err(
					`Tool '${name}' is not available in this step. Available tools: ${[...registry.keys()].join(', ') || 'none'}`
				)
			);
		return entry.run(input, callId).pipe(
			Effect.flatMap((answer) =>
				encodeAnswer(answer).pipe(
					Effect.mapError(
						(error) => new Error(`Failed to encode result for tool '${name}': ${error.message}`)
					),
					Effect.as(answer)
				)
			),
			Effect.catch((error) => Effect.succeed(err(error.message)))
		);
	};

	const runMcp: Catalogue['run'] = (name, input, callId) =>
		execute(mcpEntries, name, input, callId);

	const { hostOffered, mcpTools } = yield* bindContributedTools(
		x,
		add,
		hold,
		mcpEntries,
		runMcp,
		agent,
		staff
	);

	const fixed = fixedTools(x.audience, x.child, has);
	const over = new Set(
		mcpTools
			.map((tool) => tool.name)
			.sort()
			.slice(Math.max(0, TOOLS_PER_REQUEST - fixed.length - hostOffered.length))
	);
	for (const name of over) {
		mcpEntries.delete(name);
		yield* Effect.logWarning(
			new ToolRejected({
				tool: name,
				reason: 'limit',
				message: `MCP tool '${name}' is not offered: ${REJECTED.limit}`
			})
		);
	}
	const advertised = mcpTools.filter((tool) => !over.has(tool.name));
	const run: Catalogue['run'] = (name, input, callId) =>
		entries.has(name) || !mcpEntries.has(name)
			? execute(entries, name, input, callId)
			: runMcp(name, input, callId);
	self = run;

	const index: CatalogueIndex = {
		...catalogueIndex(e.manifest, a, x.skills, advertised, acts, automations, sync_controls),
		...(entries.has('page')
			? { 'page:paths': navigation_paths(nav(e.manifest, a), a.admin).join(', ') }
			: {})
	};

	return {
		fixed,
		host: hostOffered,
		mcp: advertised,
		available: [...entries.values(), ...mcpEntries.values()].map((entry) => entry.tool),
		index,
		presentation: (name, input) => {
			const host =
				name === runToolTool.name && isObj(input) && typeof input['name'] === 'string'
					? mcpEntries.get(input['name'])
					: undefined;
			const bound = host ?? entries.get(name);
			const definition = bound?.tool;
			const given = host !== undefined && isObj(input) ? input['input'] : input;
			const view =
				bound?.view === undefined
					? undefined
					: Result.getOrUndefined(
							Result.try(() => bound.view?.(given ?? {})).pipe(Result.flatMap(decodeView))
						);
			return {
				name: host?.tool.name ?? name,
				input: given === undefined ? {} : given,
				...(definition?.studio === undefined ? {} : { studio: definition.studio }),
				...(view === undefined ? {} : { view }),
				behavior: definition?.behavior ?? {}
			};
		},
		run
	} satisfies Catalogue;
});
