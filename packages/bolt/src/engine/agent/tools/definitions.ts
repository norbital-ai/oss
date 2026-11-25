import { Schema } from 'effect';
import {
	CONVERT_TARGETS,
	model_schema,
	PAPER_SIZES,
	type ToolBehavior
} from '@norbital-ai/host-api';
import { FILE_SHAPE } from '../run-js.ts';
import { JOBS } from './jobs.ts';
import {
	CLOSED,
	Decide,
	InviteInput,
	READ_LINES,
	ReadInput,
	RunInput,
	ToolJson,
	WriteInput,
	type AgentTool,
	type Audience,
	type HostGives,
	type ToolDefinition,
	type ToolPolicy
} from './types.ts';

export const offers = (tool: ToolPolicy, audience: Audience, child: boolean, has: HostGives) =>
	(tool.audiences?.includes(audience) ?? true) &&
	!(child && tool.child === false) &&
	(tool.needs === undefined || has[tool.needs]);

export const defineTool = <
	S extends Schema.Top & { readonly DecodingServices: never; readonly EncodingServices: never }
>(
	name: string,
	spec: {
		readonly description: string;
		readonly parameters: S;
		readonly behavior?: ToolBehavior;
		readonly policy?: ToolPolicy;
	}
): ToolDefinition<S['Type']> => ({
	name,
	description: spec.description,
	behavior: spec.behavior ?? {},
	...spec.policy,
	input: model_schema(spec.parameters),
	decode: Schema.decodeUnknownEffect(spec.parameters, CLOSED)
});

const READ_TEXT = `Read records. request: { "<model>": { where, fields, order_by, limit, after, search, aggregate, as_of, output, "<relation>": { where, fields, order_by, limit, search, aggregate, "<relation>": { ... } } } }, each root once. output defaults to "default". order_by: "<field>" or { "<field>": "asc"|"desc" } (one key, the field's name), or a list.
where: { <field>: { eq|ne|lt|lte|gt|gte|in|is_null: value, like: "%text%" (ignores case), contains: value (a period or a JSON field) } }, { "$search": "<words>" } (each word required), and/or/not; on a relation { is|some|none|every: where } or { count|sum|avg|min|max: … }; a value may be { var: CEL over requestor, today, now }.
search: words (ranked, not required), { <index>: input } or { semantic: text }. aggregate: { count, sum|avg|min|max: [field], by: field | { day|week|month|quarter|year: field } or a list of those }; a field there may be "<link>.<field>" through links to one record.
Normal reads return { rows, next, total } (total counts every match before limit, so omit aggregate when reading rows). aggregate takes no fields or search, with optional grouping by. Long values are clipped.`;

export const recordsTool = defineTool('read', {
	behavior: { data: true, resume: { argument: 'after', roots: true } },
	description: READ_TEXT,
	parameters: ReadInput
});

export const agentReadTool = defineTool('read', {
	behavior: recordsTool.behavior,
	description: `${READ_TEXT}
On a root, history: true adds $history (up to 20 revisions), approvals: true adds $approvals (steps, deciders, moves).
Ledger roots, each answering { rows, next } newest first: "$runs": { id, automation (a name or prefix*), status, cause, since, until, limit, after } automation runs, id one in full with input, result, attempts and log; "$approvals": { model, ids, all } approval requests you may see, open ones unless all, at most the newest 200 in one page (no limit or after); "$logs": { level, text, run, automation, conversation, since, until, limit, after } live's runtime log; "$audit": { id, text, actor_id, category, action, status, model, record, run, since, until, limit, after } the audit trail.`,
	parameters: ReadInput
});

export const describeTool = defineTool('describe_workspace', {
	behavior: { data: true },
	description:
		"Apps, models, automations and row counts. names gives details; 'system' lists native setup, connections and secret names.",
	parameters: Schema.Struct({ names: Schema.optionalKey(Schema.Array(Schema.String)) })
});

export const pageTool = defineTool('page', {
	policy: { audiences: ['staff'], child: false, scripts: false },
	behavior: { page: true },
	description:
		"Control the person's live workspace tab (NOT the headless browser fleet): navigate to a /app/… Pages path, open native configure setup, click/highlight text, type by label, invoke a registered UI control action, scroll, go back/forward, or open a preview URL. Pending until the tab reports. Approvals, passwords and files are the person's.",
	parameters: Schema.Struct({
		path: Schema.optionalKey(Schema.String),
		configure: Schema.optionalKey(
			Schema.Struct({ capability: Schema.String, record: Schema.optionalKey(Schema.String) })
		),
		click: Schema.optionalKey(Schema.NonEmptyString),
		type: Schema.optionalKey(
			Schema.Struct({
				label: Schema.NonEmptyString,
				text: Schema.String,
				submit: Schema.optionalKey(Schema.Boolean)
			})
		),
		control: Schema.optionalKey(
			Schema.Struct({
				ref: Schema.NonEmptyString,
				action: Schema.NonEmptyString,
				args: Schema.optionalKey(Schema.Array(ToolJson))
			})
		),
		scroll: Schema.optionalKey(Schema.Finite),
		go: Schema.optionalKey(Schema.Literals(['back', 'forward'])),
		highlight: Schema.optionalKey(Schema.NonEmptyString),
		preview: Schema.optionalKey(Schema.String)
	})
});

export const actTool = defineTool('act', {
	policy: { child: false },
	behavior: { data: true },
	description: `Commit { acts: { "<model>.<verb>": input }, key? } atomically. input_file can hold the map. Reuse key only for the same operation. Mint UUIDs to link new rows across entries.
create: [{ column: value, relation: [new row | { id, revision }] }]; update: [{ target, set: { column, relation: { create, update, delete, link, unlink } } }]; delete: [{ target }]; import: { rows, on_conflict: "update"|"keep"|"refuse", on_missing?: "create"|"skip", prune?, dry_run? }. Targets and existing relation links need { id, revision }. Ref fields take a scalar id string, never a label or { id }; file fields take file ids. Read current ids, revisions and needed rows before a batch. Returns stored rows or holds for approval.`,
	parameters: WriteInput
});

export const runAutomationTool = defineTool('run', {
	policy: { child: false },
	behavior: { data: true },
	description:
		'Run an automation from describe_workspace. Calls return output; jobs return run ids and report completion. input_file replaces input. Reuse key only to retry the same job.',
	parameters: RunInput
});

export const decideTool = defineTool('decide', {
	policy: { child: false },
	behavior: { data: true },
	description:
		'Decide an approval request as its authorized approver: request_id, decision and optional reason. The person confirms the decision in the app.',
	parameters: Decide
});

export const inviteTool = defineTool('invite', {
	policy: { child: false },
	behavior: { data: true },
	description:
		'Invite members as a workspace administrator: members is a list of email or phone and optional team. The person confirms the invitations in the app.',
	parameters: InviteInput
});

export const connectTool = defineTool('connect', {
	policy: { audiences: ['staff', 'member'], child: false, scripts: false },
	behavior: { data: true },
	description:
		'Create a connection with non-secret configuration, or pair one by instance or envoy + integration. owner is me or workspace; envoy deploys it. The person supplies credentials privately on a card. Returns instance, integration, owner and state after pairing.',
	parameters: Schema.Struct({
		integration: Schema.optionalKey(Schema.String),
		owner: Schema.optionalKey(Schema.Literals(['me', 'workspace'])),
		name: Schema.optionalKey(Schema.String),
		configuration: Schema.optionalKey(ToolJson),
		envoy: Schema.optionalKey(Schema.String),
		instance: Schema.optionalKey(Schema.String)
	})
});

export const syncTool = defineTool('sync', {
	behavior: { data: true },
	description:
		'Run a native sync (model, sync from describe_workspace). Remote read input: { instance?, partition? } or {}. File transfer: { mode: "import", file, context? } or { mode: "template"|"export", to?, where?, context? }, reading and writing as you. Your permissions admit it; it ends at your next step. Never schedulable as an automation.',
	parameters: Schema.Struct({
		model: Schema.String,
		sync: Schema.String,
		input: Schema.optionalKey(ToolJson),
		key: Schema.optionalKey(Schema.NonEmptyString)
	})
});

export const updatePlanTool = defineTool('update_plan', {
	policy: { audiences: ['staff', 'member'], child: false, scripts: false },
	description:
		'Plan mode only; unavailable during execution. Write the draft plan: body replaces it, patch { old, new } changes one exact passage.',
	parameters: Schema.Struct({
		body: Schema.optionalKey(Schema.String),
		patch: Schema.optionalKey(Schema.Struct({ old: Schema.String, new: Schema.String })),
		expected_revision: Schema.optionalKey(Schema.Number.check(Schema.isInt()))
	})
});

const SkillRequest = Schema.Struct({
	name: Schema.String,
	section: Schema.optionalKey(Schema.String),
	sections: Schema.optionalKey(Schema.Array(Schema.NonEmptyString).check(Schema.isMaxLength(12))),
	file: Schema.optionalKey(Schema.String),
	files: Schema.optionalKey(Schema.Array(Schema.NonEmptyString).check(Schema.isMaxLength(12)))
});

export const skillTool = defineTool('skill', {
	behavior: { data: true },
	description:
		'Read one skill or several at once (requests): whole, exact ## sections (section/sections), one file (file), or several files (files). Use workspace_lang for component APIs.',
	parameters: Schema.Struct({
		name: Schema.optionalKey(Schema.String),
		section: Schema.optionalKey(Schema.String),
		sections: Schema.optionalKey(Schema.Array(Schema.NonEmptyString).check(Schema.isMaxLength(12))),
		file: Schema.optionalKey(Schema.String),
		files: Schema.optionalKey(Schema.Array(Schema.NonEmptyString).check(Schema.isMaxLength(12))),
		requests: Schema.optionalKey(Schema.Array(SkillRequest).check(Schema.isMaxLength(8)))
	})
});

export const historyTool = defineTool('history', {
	description:
		"Search earlier messages in this conversation, or scope mine for all of this person's.",
	parameters: Schema.Struct({
		query: Schema.String,
		scope: Schema.optionalKey(Schema.Literals(['this', 'mine'])),
		limit: Schema.optionalKey(Schema.Number.check(Schema.isInt()))
	})
});

export const readMessagesTool = defineTool('read_messages', {
	policy: { audiences: ['channel'] },
	description:
		"This chat's messages, newest first, before a message seq (default: the newest), at most limit (≤ 50).",
	parameters: Schema.Struct({
		before: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
		limit: Schema.optionalKey(Schema.Number.check(Schema.isInt()))
	})
});

export const readFileTool = defineTool('read_file', {
	behavior: { data: true },
	description:
		"Read or view a file by id or '<reference>/<path>': images ({ id }), documents, PDFs, sheets, recordings, archives and references. offset/limit/text page or search lines; image n, page n (PDF), or crops (≤8 [l,t,r,b] 0..1 regions, ≤3 zooms/doc/turn) show images; password unlocks a document.",
	parameters: Schema.Struct({
		id: Schema.String,
		path: Schema.optionalKey(Schema.String).annotate({
			description: "path inside a reference or archive ('a.zip/b.txt')"
		}),
		offset: Schema.optionalKey(Schema.Int).annotate({
			description: '1-based start line, or hit ordinal with text'
		}),
		limit: Schema.optionalKey(Schema.Int).annotate({ description: `lines, at most ${READ_LINES}` }),
		text: Schema.optionalKey(Schema.String),
		image: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
		page: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
		crops: Schema.optionalKey(
			Schema.Array(Schema.Tuple([Schema.Number, Schema.Number, Schema.Number, Schema.Number]))
				.check(Schema.isMaxLength(8))
				.annotate({ description: '[left, top, right, bottom], fractions 0 to 1' })
		),
		password: Schema.optionalKey(Schema.String).annotate({
			description: 'password for an encrypted file'
		})
	})
});

export const readOutputTool = defineTool('read_output', {
	behavior: { data: true, resume: { argument: 'offset' } },
	description: 'The rest of a clipped tool result, by its call id, from a character offset.',
	parameters: Schema.Struct({
		call: Schema.String,
		offset: Schema.optionalKey(Schema.Number.check(Schema.isInt()))
	})
});

export const geocodeTool = defineTool('geocode', {
	description:
		'Places for an address or name (query), or at a point (reverse), each with the point a geolocation field takes.',
	parameters: Schema.Struct({
		query: Schema.optionalKey(Schema.String),
		reverse: Schema.optionalKey(Schema.Struct({ lat: Schema.Number, lng: Schema.Number }))
	})
});

export const readSource = defineTool('workspace_read', {
	policy: { audiences: ['staff'], needs: 'source' },
	behavior: { pure: true, data: true },
	description:
		'Read a workspace source file or directory (numbered lines/entries with offset/limit; use workspace_lang for package types). In run_js, unpaged reads return {path,content,lines}.',
	parameters: Schema.Struct({
		path: Schema.String.annotate({ description: 'File or directory to read' }),
		offset: Schema.optionalKey(Schema.Int).annotate({
			description: '1-based start line or entry'
		}),
		limit: Schema.optionalKey(Schema.Int).annotate({
			description: 'Max lines or entries (default and cap 2000)'
		})
	})
});

export const grepSource = defineTool('workspace_grep', {
	policy: { audiences: ['staff'], needs: 'source' },
	behavior: { pure: true, data: true },
	description:
		'Search workspace source by regex or literal. count returns match/file totals; otherwise limit caps excerpts.',
	parameters: Schema.Struct({
		count: Schema.optionalKey(Schema.Boolean),
		pattern: Schema.NonEmptyString.annotate({
			description: 'Regex or literal text to match'
		}),
		path: Schema.optionalKey(Schema.String).annotate({
			description: 'File or directory to search (default: root)'
		}),
		include: Schema.optionalKey(Schema.NonEmptyString).annotate({
			description: 'Glob filter (e.g. "*.ts", "*.svelte")'
		}),
		literal: Schema.optionalKey(Schema.Boolean).annotate({
			description: 'Match pattern literally (default: false)'
		}),
		caseSensitive: Schema.optionalKey(Schema.Boolean).annotate({
			description: 'Case-sensitive match (default: true)'
		}),
		limit: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))).annotate({
			description: 'Max matching lines (default: 100)'
		})
	})
});

export const globSource = defineTool('workspace_glob', {
	policy: { audiences: ['staff'], needs: 'source' },
	behavior: { pure: true, data: true },
	description: 'Find workspace source paths matching a glob (e.g. "src/**/*.svelte").',
	parameters: Schema.Struct({
		pattern: Schema.NonEmptyString.annotate({ description: 'Glob pattern' }),
		path: Schema.optionalKey(Schema.String).annotate({
			description: 'Directory to search (default: root)'
		}),
		hidden: Schema.optionalKey(Schema.Boolean).annotate({
			description: 'Include hidden files (default: false)'
		}),
		limit: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))).annotate({
			description: 'Max paths returned (default: 100)'
		})
	})
});

export const listSource = defineTool('workspace_list_dir', {
	policy: { audiences: ['staff'], needs: 'source' },
	behavior: { pure: true, data: true },
	description: 'List workspace source tree under path (default: root) with folder roles.',
	parameters: Schema.Struct({ path: Schema.optionalKey(Schema.String) })
});

export const taskTool = defineTool('task', {
	policy: { child: false, scripts: false, needs: 'delegation' },
	behavior: { data: true },
	description: `Manage background subagents (≤4 running). action: 'start' (default) launches or resumes (with task_id) a 'general' or active envoy subagent and returns task_id immediately (result wakes you later; subagents cannot run approval-gated tools); 'read' inspects status, recent messages/steps, writes and source diffs; 'stop' stops a running task.`,
	parameters: Schema.Struct({
		action: Schema.optionalKey(Schema.Literals(['start', 'read', 'stop'])).annotate({
			description: "Operation: 'start' (default), 'read', or 'stop'"
		}),
		task_id: Schema.optionalKey(Schema.String).annotate({
			description:
				"Task id: required for 'read'/'stop'; optional for 'start' to resume an existing session"
		}),
		description: Schema.optionalKey(Schema.String).annotate({
			description: "Short (3-5 words) description (for 'start')"
		}),
		prompt: Schema.optionalKey(Schema.String).annotate({
			description: "Task instructions for the subagent (required for 'start')"
		}),
		subagent_type: Schema.optionalKey(Schema.String).annotate({
			description: "Agent type for 'start': 'general' or an active envoy id"
		})
	})
});

export const downloadTool = defineTool('download', {
	policy: { audiences: ['staff'], child: false },
	description:
		"Save a public http(s) file as the person's: media, a PDF, HTML or CAD, at most 100 MiB.",
	parameters: Schema.Struct({ url: Schema.String })
});

export const runJsTool = defineTool('run_js', {
	policy: { scripts: false },
	behavior: { data: true },
	description: `Async JS in a fresh billed isolate; no require, process, fetch or timers. await tool(name,input) calls as you (≤200); errors throw. Filter results here; return only what you need. Files: input.files. http: true enables await http({method?,url,headers?,body?}) → {status,headers,text}, public HTTPS GET/HEAD; 'send' permits writes after confirmation. Return {files:[{name,text|base64}]} for downloads. file runs '<skill>/<path>' or '<reference>/<path>' with args, /in and /out. Limits: 3 s CPU, 256 MiB, 60 s, 4 MiB answer.`,
	parameters: Schema.Struct({
		code: Schema.optionalKey(Schema.String),
		input: Schema.optionalKey(ToolJson),
		file: Schema.optionalKey(Schema.String),
		args: Schema.optionalKey(Schema.Array(Schema.String)),
		files: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.String }))).annotate({
			description: `conversation files: input.files is an array of ${FILE_SHAPE}, in this order`
		}),
		http: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Literal('send')]))
	})
});

export const askTool = defineTool('ask', {
	policy: { scripts: false },
	description:
		'Sends one question with optional answer choices to the person, or in a sub-agent to the agent that delegated the task, then ends the turn.',
	parameters: Schema.Struct({
		question: Schema.String,
		options: Schema.optionalKey(Schema.Array(Schema.String))
	})
});

export const waitTool = defineTool('wait', {
	policy: { scripts: false },
	description: `Wait up to ${JOBS.waitMs / 1000} s for the first of jobs (default: any of this turn) to end. A finished job also arrives at your next step.`,
	parameters: Schema.Struct({
		jobs: Schema.optionalKey(Schema.Array(Schema.String)),
		seconds: Schema.optionalKey(Schema.Number.check(Schema.isInt()))
	})
});

export const runToolTool = defineTool('run_tool', {
	description:
		'Run a tool a catalogue note added after this conversation began: run_tool { name, input }.',
	parameters: Schema.Struct({ name: Schema.String, input: Schema.optionalKey(ToolJson) })
});

export const documentTool = defineTool('document', {
	description:
		'Make a file from markdown (tables and inline HTML allowed) and offer it to the person; a file field takes its id. In pptx each ## starts a slide.',
	parameters: Schema.Struct({
		to: Schema.Literals(CONVERT_TARGETS),
		name: Schema.String,
		markdown: Schema.String,
		page: Schema.optionalKey(Schema.Literals(PAPER_SIZES)),
		landscape: Schema.optionalKey(Schema.Boolean)
	})
});

export const HistoryRevisions = Schema.Array(
	Schema.StructWithRest(
		Schema.Struct({
			actor: Schema.NullOr(Schema.Struct({ kind: Schema.String, id: Schema.String }))
		}),
		[Schema.Record(Schema.String, Schema.Json)]
	)
);

const ALL_TOOLS = [
	agentReadTool,
	describeTool,
	pageTool,
	actTool,
	runAutomationTool,
	decideTool,
	inviteTool,
	connectTool,
	syncTool,
	updatePlanTool,
	skillTool,
	historyTool,
	readMessagesTool,
	readFileTool,
	readOutputTool,
	geocodeTool,
	readSource,
	grepSource,
	globSource,
	listSource,
	taskTool,
	documentTool,
	downloadTool,
	runJsTool,
	askTool,
	waitTool,
	runToolTool
];

/** The fixed tool list of an audience (a sub-agent's when `child`) on a host that gives what `has` says. */
export const fixedTools = (audience: Audience, child: boolean, has: HostGives): readonly AgentTool[] =>
	ALL_TOOLS.filter((tool) => offers(tool, audience, child, has)).map(
		({ name, description, input, behavior }) => ({ name, description, input, behavior })
	);

export const FIXED_NAMES: ReadonlySet<string> = new Set(ALL_TOOLS.map((tool) => tool.name));
