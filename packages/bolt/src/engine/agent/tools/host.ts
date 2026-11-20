import { Effect, Predicate } from 'effect';
import {
	type Downloaded,
	FacilityFailure,
	type HostTool,
	type HostToolContext,
	http_allows,
	http_auth,
	http_target,
	Port,
	Unavailable
} from '@norbital-ai/host-api';
import type { Json } from '../../../decl/values.ts';
import { layered } from '../../manifest.ts';
import { row as systemRow } from '../../system/rows.ts';
import { bounded } from '../context.ts';
import { FIXED_NAMES, runToolTool } from './definitions.ts';
import { conversationFiles, namedFiles, recordFile, storeFile } from './files.ts';
import { attach, err, mcpName, ok, validatorFor } from './helpers.ts';
import { jobId, JOBS } from './jobs.ts';
import {
	REJECTED,
	TOOL_NAME,
	ToolRejected,
	type AddTool,
	type AgentTool,
	type BoundTool,
	type Catalogue,
	type HoldTool,
	type ToolContext
} from './types.ts';

const InstanceRow = systemRow('sys_integration', ['id']);

export const isStudioAuthoringTool = (tool: HostTool): boolean =>
	tool.studio !== undefined || tool.behavior.source_edit === true;

export const bindContributedTools = Effect.fn('AgentTool.bindContributed')(function* (
	x: ToolContext,
	add: AddTool,
	hold: HoldTool,
	mcpEntries: Map<string, BoundTool>,
	runMcp: Catalogue['run'],
	agent: boolean,
	staff: boolean
) {
	const e = x.engine,
		a = x.authority;
	const hostOffered: AgentTool[] = [];
	const activeBrowserTools = a.preview === undefined ? x.browser_tools : [];
	const authoringSession =
		x.inApp && staff && (x.draft !== undefined || (x.workspace !== undefined && a.admin));
	const activeHostTools =
		x.inApp && staff
			? x.host_tools.filter((host) => authoringSession || !isStudioAuthoringTool(host))
			: [];

	const discovered = x.mcpTools.map((tool) => ({ tool, name: mcpName(tool.server, tool.name) }));
	const taken = new Map<string, number>();
	for (const name of [...activeBrowserTools, ...activeHostTools, ...discovered].map(
		(tool) => tool.name
	))
		taken.set(name, (taken.get(name) ?? 0) + 1);

	const rejected = (name: string, what: string) => {
		const reason = !TOOL_NAME.test(name)
			? 'unsupported'
			: FIXED_NAMES.has(name)
				? 'native'
				: (taken.get(name) ?? 0) > 1
					? 'shared'
					: undefined;
		return reason === undefined
			? Effect.succeed(false)
			: Effect.as(
					Effect.logWarning(
						new ToolRejected({
							tool: name,
							reason,
							message: `${what} is not offered as '${name}': ${REJECTED[reason]}`
						})
					),
					true
				);
	};

	const mcpTools: AgentTool[] = [];
	for (const { tool, name } of discovered) {
		if (
			(yield* rejected(name, `MCP tool '${tool.name}' of ${tool.server}`)) ||
			!Predicate.isObject(tool.input)
		)
			continue;
		const definition = {
			name,
			description: tool.description,
			input: tool.input,
			behavior: {}
		};
		mcpTools.push(definition);
		if (!agent) continue;
		const schema = tool.input;
		add(
			{ ...definition, decode: Effect.succeed },
			function* (given) {
				const input = validatorFor(x.validators, schema)(given);
				if (typeof input === 'string') return err(input);
				return (
					hold(definition.name, input, 'call an MCP tool') ??
					ok(yield* x.mcp.call(tool.server, tool.name, input))
				);
			},
			{},
			mcpEntries
		);
	}

	add(runToolTool, function* (i, callId) {
		if (FIXED_NAMES.has(i.name) || hostOffered.some((tool) => tool.name === i.name))
			return err(`'${i.name}' is in your tool list: call it by its own name.`);
		return yield* runMcp(i.name, i.input === undefined ? {} : i.input, callId);
	});

	const viaConnection = Effect.fnUntraced(function* (
		integration: string,
		request: { readonly method: string; readonly path: string; readonly max_bytes: number }
	) {
		const sealed = e.credentials,
			http = e.http,
			definition = layered(e.manifest).integrations[integration],
			spec = definition?.http,
			member = a.actor.kind === 'member' ? a.actor.id : null;
		if (sealed === undefined || http === undefined || spec === undefined) return undefined;
		const [row] = yield* e.db.rows(InstanceRow, {
			text: `SELECT id FROM sys_integration WHERE integration = $1 AND active AND (owner = $2 OR (owner IS NULL AND $3)) ORDER BY owner IS NULL, id LIMIT 1`,
			params: [integration, member, a.admin || spec.lend === true]
		});
		if (row === undefined) return undefined;
		if (!spec.base_url.startsWith('https://') || definition?.oauth !== undefined)
			return yield* new FacilityFailure({
				kind: 'unsupported',
				message: `the ${integration} connection takes no host request`
			});
		const url = yield* Effect.try({
			try: () => http_target(spec.base_url, request.path),
			catch: (error) =>
				error instanceof FacilityFailure
					? error
					: FacilityFailure.invalid('the request URL is invalid')
		});
		if (!http_allows(spec.allow, spec.base_url, request.method, url))
			return yield* new FacilityFailure({
				kind: 'unsupported',
				message: `this connection does not allow ${request.method.toUpperCase()} ${url.pathname}`
			});
		const signed = http_auth(spec.auth, (yield* sealed.read(row.id)).values.get('credential'));
		if (signed === undefined)
			return yield* new Unavailable({
				facility: 'http',
				reason: 'the connection is not paired: its credential is missing'
			});
		return yield* http.fetch(
			{
				method: request.method.toUpperCase(),
				url: url.href,
				headers: Object.entries({ 'user-agent': 'norbital', ...signed })
			},
			{ redirects: 5, max_bytes: request.max_bytes }
		);
	});

	for (const host of [...activeBrowserTools, ...activeHostTools]) {
		const { name, description, input: schema, behavior } = host;
		if (
			(yield* rejected(name, `host tool '${name}'`)) ||
			!Predicate.isObject(schema) ||
			!(
				a.admin ||
				a.capabilities.tools.includes(name) ||
				(host.source === true && host.read_only === true)
			)
		)
			continue;
		hostOffered.push({ name, description, input: schema, behavior });
		if (!(agent || host.read_only === true)) continue;
		add(
			{ name, description, input: schema, behavior, decode: Effect.succeed },
			function* (given, id) {
				const input = validatorFor(x.validators, schema)(given);
				if (typeof input === 'string') return err(input);
				const held =
					host.confirm?.(input) === true ? hold(name, input, `use ${name} this way`) : undefined;
				if (held !== undefined) return held;
				const files = host.files === true ? yield* conversationFiles(x, namedFiles(input)) : [];
				if (typeof files === 'string') return err(files);
				const shown: { name: string; mime: string; bytes: Uint8Array }[] = [],
					kept: Downloaded[] = [];
				const job = jobId();
				const context: HostToolContext = {
					actor: a.actor,
					conversation: x.conv.id,
					...(a.agent === undefined ? {} : { agent: a.agent }),
					turn: x.turn,
					call_id: id,
					job,
					...(x.question === undefined ? {} : { question: x.question }),
					attach: (file) => {
						attach(x.files, file);
						if (host.studio === 'view')
							shown.push({
								name: `${name}-${shown.length + 1}.${file.mime.split('/')[1] ?? 'png'}`,
								...file
							});
					},
					keep: (file) => kept.push(file),
					files: files.map((file) => [file.name, file.bytes] as const),
					request: (integration, request, signal) =>
						Effect.runPromise(viaConnection(integration, request), { signal })
				};
				const offered = Effect.fnUntraced(function* (result: Json) {
					if (
						!Predicate.isObject(result) ||
						(kept.length === 0 && (shown.length === 0 || e.files === undefined))
					)
						return result;
					const storedFiles: Json[] = [];
					if (e.files !== undefined)
						for (const f of shown) storedFiles.push(yield* storeFile(x, e.files, f));
					for (const f of kept) storedFiles.push(yield* recordFile(x, f));
					return { ...result, files: storedFiles };
				});
				yield* x.jobs.add(
					name,
					Port.attempt(name, (signal) => host.call(input, context, signal)).pipe(
						Port.call(name, host.wall_ms ?? JOBS.hostMs),
						Effect.flatMap(offered)
					),
					{
						id: job,
						...(host.reports_end === true ? { reported: true } : {}),
						behavior,
						...(host.studio === undefined ? {} : { studio: host.studio }),
						alert: (jobIdStr: string, result: Json) =>
							`[job ${jobIdStr} finished] ${name}: ${JSON.stringify(bounded(result).value)}`
					}
				);
				const inline = yield* x.jobs.wait([job], x.inlineMs ?? JOBS.inlineMs);
				return ok(
					inline?.result ?? {
						job,
						note: 'Still running; keep working. Its result arrives by itself, or wait returns it.'
					}
				);
			},
			{
				...(host.studio === undefined ? {} : { studio: host.studio }),
				...(host.view === undefined ? {} : { view: (input: Json) => host.view?.(input) })
			}
		);
	}

	return { hostOffered, mcpTools };
});
