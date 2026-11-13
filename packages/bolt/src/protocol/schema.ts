// The wire's Schemas (A.4): every body and live frame of `/__bolt/*`, the callables that are not a model's,
// an integration instance's status, the session and host-operation bodies, and `norbital.template.json`. A body is
// decoded once where it enters (the host's request, the client's answer); every wire type is its Schema's own.
import { DateTime, Effect, Option, Schema, SchemaTransformation } from 'effect';
import { isArray } from 'effect/Array';
import { DRIVERS, type DriverName } from '../decl/runtime/integration.ts';
import { PAPER_SIZES } from '../decl/runtime/facilities.ts';
import { MessageValues } from '../decl/errors/refusal.ts';

/** An authoring phase: diagnose (`bolt build`'s checks) → copy (the preview's data) → preview → merge. */
export const STUDIO_PHASES = ['diagnose', 'copy', 'preview', 'merge'] as const;
/**
 * What a host tool is to the shell's Studio surfaces, declared so Bolt never keys behaviour on a host's tool names:
 * - `preview`: its result's `preview` is a preview it built; the agent may show that origin (`page { preview }`).
 * - `view`: a look at a rendered page; the images it attaches are shown to the person too, and its result's `url` is a
 *   preview the panel may show.
 * - `logs`: its result is `{ records: StudioLogLine[] }`, listed in full on the step.
 * - `publish` / `rollback`: a confirmed switch-over; its input is `{ summary, commit }`, its card says what changes.
 * A Studio result's caption facts (`environment`, `release`, `commit`, `message`, `branch`, `url`, `viewport`,
 * `capturedAt`) are read at its top level.
 */
export const STUDIO_ROLES = ['preview', 'view', 'logs', 'merge', 'rollback'] as const;

/** Native tool behavior, declared by its owner and carried with its stored step. */
export const ToolBehavior = Schema.Struct({
	pure: Schema.optionalKey(Schema.Literal(true)),
	progress_check: Schema.optionalKey(Schema.Literal(true)),
	diagnostics: Schema.optionalKey(Schema.Literal(true)),
	discovery: Schema.optionalKey(Schema.Literal(true)),
	data: Schema.optionalKey(Schema.Literal(true)),
	page: Schema.optionalKey(Schema.Literal(true)),
	downloads: Schema.optionalKey(Schema.Literal(true)),
	resume: Schema.optionalKey(Schema.Struct({ argument: Schema.String, roots: Schema.optionalKey(Schema.Literal(true)) }))
});
export type ToolBehavior = typeof ToolBehavior.Type;

/** A question keeps its choices through storage, channel delivery and the shell. */
export const AgentQuestion = Schema.Struct({
	question: Schema.String,
	options: Schema.Array(Schema.String)
});
export type AgentQuestion = typeof AgentQuestion.Type;

/** A closed action in the person's active tab: click visible text, scroll CSS pixels, or go back/forward. */
export const PageAction = Schema.Struct({
	click: Schema.optionalKey(Schema.String),
	scroll: Schema.optionalKey(Schema.Finite),
	go: Schema.optionalKey(Schema.Literals(['back', 'forward'])),
	highlight: Schema.optionalKey(Schema.String),
	type: Schema.optionalKey(
		Schema.Struct({
			label: Schema.String,
			text: Schema.String,
			submit: Schema.optionalKey(Schema.Boolean)
		})
	)
});
export type PageAction = typeof PageAction.Type;
/** The active tab's answer to a page action: whether the client found and performed it. */
export const PageResult = Schema.Struct({
	ok: Schema.Boolean,
	note: Schema.optionalKey(Schema.String),
	url: Schema.optionalKey(Schema.String),
	/** What the page shows once it settled: its headings and controls as they read. */
	screen: Schema.optionalKey(Schema.String)
});
export type PageResult = typeof PageResult.Type;

const Member = Schema.Struct({
	kind: Schema.Literal('member'),
	id: Schema.String,
	email: Schema.NullOr(Schema.String),
	phone: Schema.NullOr(Schema.String),
	external: Schema.Boolean,
	teams: Schema.Array(Schema.String),
	team_path: Schema.Array(Schema.String),
	admin: Schema.Boolean,
	party: Schema.NullOr(Schema.Struct({ model: Schema.String, id: Schema.String }))
});
const Requestor = Schema.Union([
	Member,
	Schema.Struct({
		kind: Schema.Literal('envoy'),
		envoy: Schema.String,
		instance: Schema.String,
		sender: Schema.String,
		member: Schema.NullOr(Schema.String),
		linked: Schema.optionalKey(Member)
	}),
	Schema.Struct({
		kind: Schema.Literal('visitor'),
		app: Schema.String,
		visitor: Schema.String,
		anonymous: Schema.optionalKey(Schema.Literal(true))
	}),
	Schema.Struct({ kind: Schema.Literal('api_key'), key: Schema.String })
]);
/** An engine actor (`EngineActor`): a member, an envoy's turn, a visitor, an API key or the system identity's run. */
export const EngineActorSchema = Schema.Union([
	...Requestor.members,
	Schema.Struct({
		kind: Schema.Literal('system'),
		run: Schema.String,
		by: Schema.Union([
			Schema.Struct({ automation: Schema.String }),
			Schema.Struct({ platform: Schema.String }),
			Schema.Struct({ sync: Schema.String, instance: Schema.String })
		])
	})
]);
const SystemTrigger = [
	Schema.Struct({ kind: Schema.Literal('system'), cause: Schema.Literal('cron') }),
	Schema.Struct({
		kind: Schema.Literal('system'),
		cause: Schema.Literal('effect'),
		model: Schema.String,
		verb: Schema.Literals(['create', 'update', 'delete']),
		records: Schema.Array(Schema.String)
	}),
	Schema.Struct({
		kind: Schema.Literal('system'),
		cause: Schema.Literal('schedule'),
		by: Schema.optionalKey(Schema.Union([
			Schema.Struct({ automation: Schema.String, run: Schema.String }),
			Schema.Struct({ automation: Schema.String, invocation: Schema.String })
		]))
	})
] as const;
/** An automation run's trigger (`RunTrigger`, `sys_run.trigger`). */
export const RunTriggerSchema = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal('person'),
		actor: Requestor,
		agent: Schema.optionalKey(Schema.Struct({ conversation: Schema.String }))
	}),
	...SystemTrigger
]);
/** A run's trigger as the run ledger answers it (`RunTriggerView`). */
export const RunTriggerViewSchema = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal('person'),
		ref: Schema.String,
		name: Schema.NullOr(Schema.String),
		agent: Schema.optionalKey(Schema.Literal(true))
	}),
	...SystemTrigger
]);
/** A driver bolt declares (`DRIVERS`). */
export const Driver = Schema.String.pipe(
	Schema.refine<Schema.String, DriverName>((d): d is DriverName => Object.hasOwn(DRIVERS, d))
);
/** An optional key whose value is dropped, not fatal, when it does not decode: one stray member never hides the rest. */
const tolerant = <S extends Schema.Constraint>(schema: S) =>
	Schema.optionalKey(Schema.catchDecoding<S>(() => Effect.succeedNone)(schema));
/** The members of a list that decode as `item`, the others dropped; anything but a list is empty. */
const listOf = <A>(item: Schema.Codec<A, unknown>): Schema.Codec<ReadonlyArray<A>, unknown> =>
	Schema.Unknown.pipe(
		Schema.decodeTo(
			Schema.Array(Schema.toType(item)),
			SchemaTransformation.transform<ReadonlyArray<A>, unknown>({
				decode: (u) =>
					isArray(u) ? u.flatMap((x) => Option.toArray(Schema.decodeUnknownOption(item)(x))) : [],
				encode: (xs) => xs
			})
		)
	);

// ── reads, acts, live ──
const READ_METHODS = [
	'aggregate',
	'history',
	'query',
	'transcript',
	'inbox',
	'conversations',
	'runs'
] as const;
/**
 * One read as the guest names it (`ctx.query('c', q)` → `{ m: 'query', a: ['c', q] }`; a read request
 * `ctx.query({ … })` → `{ m: 'query', a: [request] }`); `lower_read` decodes `a`.
 * `transcript` (`a: [conversation]`) and `conversations` (`a: []`, the member's own) are the agent panel's, live only:
 * `/live` checks the caller may read them, `/q` refuses them. `runs` (`a: [{ automation?, id?, limit?, brief? }]`) is the runs
 * the caller may see, live through `sys_run` changes.
 */
export const WireRead = Schema.Struct({
	m: Schema.Literals(READ_METHODS),
	a: Schema.Array(Schema.Json)
});
export type WireRead = typeof WireRead.Type;
export const QBody = Schema.Struct({ reads: Schema.Array(WireRead) });
export type QBody = typeof QBody.Type;
export const QReply = Schema.Struct({ answers: Schema.Array(Schema.Json) });
export type QReply = typeof QReply.Type;
/**
 * `/act`: every write, action, `start` and approval decision; the key rides `Idempotency-Key`. A model's
 * callable is `<model>.<name>`; the others are `OwnCall`'s.
 */
export const WriteMapBody = Schema.Struct({
	acts: Schema.Record(Schema.String, Schema.Json),
	issued_at: Schema.String
});
export type WriteMapBody = typeof WriteMapBody.Type;
/** Platform and agent commands have their own input codecs and capabilities. */
export const CommandBody = Schema.Struct({
	callable: Schema.String,
	input: Schema.Json,
	issued_at: Schema.String,
	observed: Schema.optionalKey(Schema.Record(Schema.String, Schema.Number))
});
export const ActBody = Schema.Union([WriteMapBody, CommandBody]);
export type ActBody = typeof ActBody.Type;
/** Native manual sync control; sync identities never enter the author callable namespace. */
export const SyncControlBody = Schema.Struct({
	model: Schema.String,
	sync: Schema.String,
	id: Schema.String,
	input: Schema.Json,
	issued_at: Schema.String
});
export type SyncControlBody = typeof SyncControlBody.Type;

/** A refusal's code: an authored `refused` or one of the platform's (`PlatformRefusal`). */
export const REFUSAL_CODES = [
	'refused',
	'locked',
	'source_changed',
	'timeout',
	'unsupported',
	'read_budget_exceeded',
	'forbidden',
	'not_found',
	'invalid_input',
	'unique',
	'check',
	'overlap',
	'missing_ref',
	'restricted',
	'required',
	'overflow',
	'rate_limited',
	'key_reuse',
	'approval_split',
	/** The act names a contract this workspace no longer runs; reload the page. */
	'release_changed',
	/** An `issued_at` older than 23 hours or more than five minutes ahead. */
	'expired',
	/** Tenant-code exceptions and guest budgets. */
	'internal',
	'cpu_budget',
	'crossing_budget',
	'memory',
	'too_large'
] as const;
export const Written = Schema.Array(
	Schema.Struct({ model: Schema.String, id: Schema.String, revision: Schema.Number })
);
/** A write's outcome, told apart by `kind`: what the engine stores and replays for an idempotency key. */
export const WriteOutcome = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal('committed'),
		output: Schema.Json,
		records: Written,
		/** An act that wrote no row: the records that already held every supplied value (after callbacks). */
		unchanged: Schema.optionalKey(
			Schema.Array(Schema.Struct({ model: Schema.String, id: Schema.String }))
		)
	}),
	Schema.Struct({
		kind: Schema.Literal('pending_approval'),
		request_id: Schema.String,
		records: Written
	}),
	Schema.Struct({
		kind: Schema.Literal('refused'),
		code: Schema.Literals(REFUSAL_CODES),
		/** The text a person reads; an authored refusal's catalogue `key` and `values` rendered it. */
		message: Schema.String,
		key: Schema.optionalKey(Schema.String),
		values: Schema.optionalKey(MessageValues),
		field: Schema.optionalKey(Schema.String),
		row: Schema.optionalKey(Schema.Number),
		rows: Schema.optionalKey(Schema.Array(Schema.Number)),
		/** The tenant code that refused — `'<model>.transform'` or `'<model>.<action>'`. */
		rule: Schema.optionalKey(Schema.String),
		data: Schema.optionalKey(Schema.Struct({ request_id: Schema.String }))
	}),
	Schema.Struct({
		kind: Schema.Literal('conflict'),
		records: Schema.Array(Schema.Struct({ model: Schema.String, id: Schema.String }))
	}),
	Schema.Struct({ kind: Schema.Literal('unknown'), invocation: Schema.String })
]);
/** Every answer of an act on the wire: a write's outcome, or `running` past the person-wait. */
export const Outcome = Schema.Union([
	...WriteOutcome.members,
	Schema.Struct({ kind: Schema.Literal('running'), run: Schema.String })
]);
export type Outcome = typeof Outcome.Type;
export type WriteOutcome = typeof WriteOutcome.Type;
/** `v`: the lane sequence of the act's last commit. */
export const ActReply = Schema.Struct({ outcome: Outcome, v: Schema.Number });
export type ActReply = typeof ActReply.Type;
/** A transport failure (a refusal is an outcome, never one of these). */
export const WireError = Schema.Struct({
	error: Schema.Struct({ code: Schema.String, message: Schema.String })
});
export type WireError = typeof WireError.Type;

/** A live registration. Declared-query dependencies are recorded while answering it. */
export const LiveAdd = Schema.Struct({
	view: Schema.String,
	read: WireRead
});
export type LiveAdd = typeof LiveAdd.Type;
export const LiveBody = Schema.Struct({
	conn: Schema.String,
	add: Schema.optionalKey(Schema.Array(LiveAdd)),
	drop: Schema.optionalKey(Schema.Array(Schema.String))
});
export type LiveBody = typeof LiveBody.Type;
/** `subscription_too_large`, `too_many_subscriptions`, `cell_budget`, or an engine failure's code. */
export const LiveErrorCode = Schema.String;
export type LiveErrorCode = typeof LiveErrorCode.Type;
export const LiveReply = Schema.Struct({
	errors: Schema.Array(
		Schema.Struct({ view: Schema.String, code: LiveErrorCode, message: Schema.String })
	)
});
export type LiveReply = typeof LiveReply.Type;
/**
 * A change to a view's rows: `upsert` drops the row with that id, if any, then inserts `row` at `index` of what
 * remains; `remove` drops it. On a `get` view the value is the row or `null`. A page's `next` is never patched.
 */
export const PatchOp = Schema.Union([
	Schema.Struct({ op: Schema.Literal('upsert'), index: Schema.Number, row: Schema.Json }),
	Schema.Struct({ op: Schema.Literal('remove'), id: Schema.String }),
	/** One top-level value of a page beside its rows (a transcript's conversation `status`), set without a re-read. */
	Schema.Struct({ op: Schema.Literal('meta'), key: Schema.String, value: Schema.Json }),
	Schema.Struct({ op: Schema.Literal('unset'), key: Schema.String })
]);
export type PatchOp = typeof PatchOp.Type;
export const Frame = Schema.Union([
	Schema.Struct({ t: Schema.Literal('hello'), conn: Schema.String, v: Schema.Number }),
	/** The whole value: a view's first answer, and every fallback that re-read it. */
	Schema.Struct({
		t: Schema.Literal('answer'),
		view: Schema.String,
		v: Schema.Number,
		value: Schema.Json,
		arrivals: Schema.optionalKey(Schema.Array(Schema.Json))
	}),
	/** The ops that turn the view's value at its last frame into its value at `v`. */
	Schema.Struct({
		t: Schema.Literal('patch'),
		view: Schema.String,
		v: Schema.Number,
		ops: Schema.Array(PatchOp),
		arrivals: Schema.optionalKey(Schema.Array(Schema.Json))
	}),
	Schema.Struct({
		t: Schema.Literal('error'),
		view: Schema.String,
		code: LiveErrorCode,
		message: Schema.String
	}),
	/** The lane advanced to `v`; everything before it is applied. */
	Schema.Struct({ t: Schema.Literal('v'), v: Schema.Number }),
	/** A generation change (reset, restore, fork admit, release flip): reload, do not reconnect. */
	Schema.Struct({ t: Schema.Literal('close'), release: Schema.String })
]);
export type Frame = typeof Frame.Type;
/** One notice of the live inbox's answer (`{ rows, unread }`). */
export const NoticeRow = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	body: Schema.NullOr(Schema.String),
	link: Schema.NullOr(Schema.Struct({ model: Schema.String, id: Schema.String })),
	at: Schema.String,
	read: Schema.Boolean
});
export type NoticeRow = typeof NoticeRow.Type;
/** An APNs device's routing: the app's bundle id, its APNs environment and the Apple team whose key signs for it. */
const ApnsKeys = Schema.Struct({
	topic: Schema.NonEmptyString,
	environment: Schema.Literals(['development', 'production']),
	team_id: Schema.NonEmptyString
});
/**
 * `POST /__bolt/push`: `{ endpoint, remove: true }`; a browser `PushSubscription.toJSON()` (kind `web`); or a native
 * iOS device, `{ kind: 'apns', endpoint: <hex device token>, keys: ApnsKeys }`.
 */
export const PushBody = Schema.Union([
	Schema.Struct({ endpoint: Schema.String, remove: Schema.Literal(true) }),
	Schema.Struct({
		kind: Schema.optionalKey(Schema.Literal('web')),
		endpoint: Schema.String,
		keys: Schema.Struct({ p256dh: Schema.String, auth: Schema.String })
	}),
	Schema.Struct({ kind: Schema.Literal('apns'), endpoint: Schema.String, keys: ApnsKeys })
]);
export type PushBody = typeof PushBody.Type;

// ── the in-app agent ──
/** Every model call of a turn summed: the cost disclosure's data; on a reply, the context it filled and the model that wrote it. */
export const Usage = Schema.Struct({
	input: Schema.Number,
	output: Schema.Number,
	calls: Schema.Number,
	cost: Schema.optionalKey(Schema.Number),
	/** input tokens the provider read from its prompt cache, and output tokens spent reasoning, summed */
	cached: Schema.optionalKey(Schema.Number),
	reasoning: Schema.optionalKey(Schema.Number),
	/** Who answered, in order of first use: more than one means a conversation left its cache. */
	providers: Schema.optionalKey(Schema.Array(Schema.String)),
	context: Schema.optionalKey(Schema.Number),
	window: Schema.optionalKey(Schema.Number),
	model: Schema.optionalKey(Schema.String)
});
export type Usage = typeof Usage.Type;
/** One transcript row as the agent panel shows it (`pending` awaits a triage decision); a held call (`state: 'confirm'`) carries the call it would make. */
export const AgentRow = Schema.Struct({
	id: Schema.String,
	seq: Schema.Number,
	role: Schema.NullOr(Schema.Literals(['user', 'assistant', 'tool', 'system'])),
	text: Schema.NullOr(Schema.String),
	/** `streaming`: a reply still being written (its text grows patch by patch); `running`: a tool call still running; `approved`: a confirmed call being carried out. */
	state: Schema.NullOr(
		Schema.Literals([
			'pending',
			'queued',
			'scheduled',
			'consumed',
			'cancelled',
			'confirm',
			'approved',
			'streaming',
			'running'
		])
	),
	/** When it was written. */
	at: Schema.optionalKey(Schema.String),
	/** A `scheduled` message's send time; none: when the running turn finishes. */
	due: Schema.optionalKey(Schema.String),
	/** The turn that took this input or wrote this reply: a reply names the inputs it answers by it. */
	turn: Schema.optionalKey(Schema.String),
	tag: Schema.NullOr(Schema.String),
	call: Schema.optionalKey(Schema.Struct({ name: Schema.String, input: Schema.Json })),
	receipts: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				outcome: Schema.Literals(['committed', 'pending_approval']),
				callable: Schema.String,
				records: Schema.Array(Schema.Struct({ model: Schema.String, id: Schema.String })),
				request_id: Schema.optionalKey(Schema.String)
			})
		)
	),
	usage: Schema.optionalKey(Usage),
	/** A question to the person, or to a sub-agent's delegating agent. */
	asked: Schema.optionalKey(Schema.Literal(true)),
	question: Schema.optionalKey(AgentQuestion),
	answered: Schema.optionalKey(Schema.Literal(true)),
	answer_to: Schema.optionalKey(Schema.String),
	/** A sub-agent's report in its parent (tag `report`): which sub-agent, and whether it asks something. */
	report: Schema.optionalKey(
		Schema.Struct({
			conversation: Schema.String,
			asked: Schema.optionalKey(Schema.Literal(true))
		})
	),
	/** Who wrote it, a failed turn's reason (staff only), what it is filed about. */
	author: Schema.optionalKey(Schema.NullOr(Schema.String)),
	detail: Schema.optionalKey(Schema.String),
	about: Schema.optionalKey(Schema.Json),
	/** The files a message carries (`id` when stored, for `file_url`). */
	files: Schema.optionalKey(
		Schema.mutable(
			Schema.Array(
				Schema.Struct({
					id: Schema.optionalKey(Schema.String),
					name: Schema.String,
					mime: Schema.String
				})
			)
		)
	),
	/** A tool step: which tool, whether its result was an error; `child` a spawned sub-agent's conversation; `runs` the automation runs an `act` started or queued; `args` and `result` at most 600 characters each (a `logs` role's result 20,000); `preview` a preview URL it names; `ms` how long it ran. */
	tool: Schema.optionalKey(
		Schema.Struct({
			name: Schema.String,
			behavior: ToolBehavior,
			failed: Schema.Boolean,
			child: Schema.optionalKey(Schema.String),
			runs: Schema.optionalKey(Schema.Array(Schema.String)),
			running: Schema.optionalKey(Schema.Literal(true)),
			args: Schema.optionalKey(Schema.String),
			result: Schema.optionalKey(Schema.String),
			/** The preview URL the result names in full (a `preview` role's, `page { preview }`'s), never clipped. */
			preview: Schema.optionalKey(Schema.String),
			/** The held request the result names (a `publish` or `rollback` role's): the person approves it on the card. */
			approval: Schema.optionalKey(Schema.String),
			navigation: Schema.optionalKey(Schema.String),
			/** A current-tab action this step requested (a closed vocabulary: click, scroll, back/forward). */
			page: Schema.optionalKey(PageAction),
			/** The active tab's answer to that request, written by the client after it acts. */
			page_result: Schema.optionalKey(PageResult),
			/** What a Studio result says it shows (environment, release, commit, message, branch, url, viewport, capturedAt), for its caption. */
			about: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
			/** A source edit's files and compact diffs, kept whole beside a clipped result for the panel's Changes tab. */
			changes: Schema.optionalKey(
				Schema.Array(
					Schema.Struct({
						path: Schema.String,
						diff: Schema.String,
						change: Schema.optionalKey(Schema.String)
					})
				)
			),
			/** The tool's declared Studio role (`HostTool.studio`). */
			studio: Schema.optionalKey(Schema.Literals(STUDIO_ROLES)),
			ms: Schema.optionalKey(Schema.Number)
		})
	),
	/** An assistant row's reasoning, verbatim. */
	reasoning: Schema.optionalKey(Schema.String),
	/** A context checkpoint: the last seq it summarizes, the rows kept beside it, who asked for it. */
	compact: Schema.optionalKey(
		Schema.Struct({
			cutoff: Schema.Number,
			keep: Schema.mutable(Schema.Array(Schema.String)),
			origin: Schema.Literals(['manual', 'requested', 'automatic'])
		})
	)
});
export type AgentRow = typeof AgentRow.Type;
/** The live `conversations` read's row: a member's own in-app conversation or an envoy's thread on an instance, most recently active first (`at`). */
export const AgentConversation = Schema.Struct({
	id: Schema.String,
	title: Schema.NullOr(Schema.String),
	at: Schema.String,
	status: Schema.Literals(['idle', 'running', 'stopped']),
	model: Schema.String,
	plan: Schema.NullOr(
		Schema.Struct({
			revision: Schema.Number,
			body: Schema.String,
			status: Schema.Literals(['draft', 'active', 'verified']),
			/** The seq execution started after. */
			checkpoint: Schema.optionalKey(Schema.Number)
		})
	),
	goals: Schema.NullOr(
		Schema.mutable(
			Schema.Array(
				Schema.Struct({
					id: Schema.String,
					text: Schema.String,
					status: Schema.Literals(['pending', 'doing', 'done'])
				})
			)
		)
	),
	/** The envoy serving an instance's thread and the instance it is on; both null exactly on a member's own in-app conversation. */
	envoy: Schema.NullOr(Schema.String),
	integration: Schema.NullOr(Schema.String),
	/** An instance thread's kind and its provider thread; null on an in-app conversation. */
	kind: Schema.NullOr(Schema.Literals(['dm', 'group'])),
	thread: Schema.NullOr(Schema.String),
	/** A DM's member by name when the sender is one; null otherwise. */
	peer: Schema.NullOr(Schema.String),
	/** The automation run whose inference this transcript records: read-only, an administrator's to read. */
	run: Schema.optionalKey(Schema.NullOr(Schema.String))
});
export type AgentConversation = typeof AgentConversation.Type;

// ── the callables that are not a model's: run starts, approval decisions, filters, the agent panel ──
const LocalFilterField = Schema.Struct({
	name: Schema.String,
	label: Schema.String,
	kind: Schema.Literals(['text', 'number', 'bool']),
	optional: Schema.optionalKey(Schema.Boolean)
});
export type LocalFilterField = typeof LocalFilterField.Type;
const Conversation = { conversation: Schema.String };
const Message = { message: Schema.String };
const ConversationIn = Schema.Struct(Conversation),
	MessageIn = Schema.Struct(Message);
const Notify = Schema.Struct({ ...Conversation, text: Schema.String });
const StartRun = Schema.Struct({ input: Schema.optionalKey(Schema.Json), id: Schema.String });
/** One run (`id`, `input`) or many (`runs`, a bulk start in one request: one run per record). */
const Run = Schema.Union([
	Schema.Struct({ automation: Schema.String, ...StartRun.fields }),
	Schema.Struct({ automation: Schema.String, runs: Schema.NonEmptyArray(StartRun) }),
	Schema.Struct({ automation: Schema.String, input: Schema.optionalKey(Schema.Json) })
]);
export const Decide = Schema.Struct({
	request_id: Schema.String,
	decision: Schema.Literals(['approve', 'reject', 'request_changes', 'withdraw']),
	reason: tolerant(Schema.String)
});
const ConvertSource = Schema.Union([
	Schema.Struct({ html: Schema.String }),
	Schema.Struct({ layout_html: Schema.String }),
	Schema.Struct({ markdown: Schema.String })
]);
const PdfOptions = {
	page: Schema.optionalKey(Schema.Literals(PAPER_SIZES)),
	landscape: Schema.optionalKey(Schema.Boolean)
};
export const PreviewPdf = Schema.Struct({
	source: ConvertSource,
	options: Schema.Struct(PdfOptions)
});
const Describe = Schema.Struct({
	model: Schema.String,
	text: Schema.String,
	fields: Schema.optionalKey(Schema.Array(LocalFilterField))
});
const Options = Schema.Struct({
	model: Schema.String,
	fields: Schema.optionalKey(Schema.Array(LocalFilterField))
});
const PostFields = Schema.Struct({
	...Conversation,
	text: Schema.String,
	/** Answer this question once, in the same commit as the message. */
	question: Schema.optionalKey(Schema.String),
	attachments: Schema.optionalKey(Schema.Array(Schema.Json)),
	/** `compact` is `/compact`; `plan` plans; anything else is the agent. */
	mode: tolerant(Schema.Literals(['agent', 'plan', 'compact'])),
	/** Skip triage. */
	now: tolerant(Schema.Boolean),
	/** Hold it: an ISO instant, or `finish` for when the running turn finishes. */
	schedule: Schema.optionalKey(Schema.String),
	/** The person's clock. */
	tz: tolerant(Schema.String)
});
/** A post carries text or an attachment. */
const Post = PostFields.check(
	Schema.makeFilter<typeof PostFields.Type>(
		(x) => x.text.trim() !== '' || (x.attachments?.length ?? 0) > 0
	)
);
const SetModel = Schema.Struct({ ...Conversation, model: Schema.String });
const SetAgent = Schema.Struct({ ...Conversation, agent: Schema.String });
const Revise = Schema.Struct({ ...Message, text: Schema.String, attachments: Schema.optionalKey(Schema.Array(Schema.Json)) });
const Reorder = Schema.Struct({ ...Conversation, messages: Schema.Array(Schema.String) });
const FileAbout = Schema.Struct({
	...Message,
	about: Schema.NullOr(Schema.Struct({ model: Schema.String, id: Schema.String })).pipe(
		Schema.withDecodingDefaultKey(Effect.succeed(null))
	)
});
const MarkNotices = Schema.Union([
	Schema.Struct({ all: Schema.Literal(true) }),
	Schema.Struct({ ids: Schema.Array(Schema.String) })
]);
const Confirm = Schema.Struct({ ...Message, approve: Schema.Boolean });
/** A per-record restore's target: one live record and the past revision whose own fields it takes back. */
const RestoreTarget = Schema.Struct({
	model: Schema.String,
	record: Schema.String,
	revision: Schema.Number
});
const own = <C extends string, I extends Schema.Constraint>(callable: C, input: I) =>
	Schema.Struct({ callable: Schema.Literal(callable), input });
/** An own callable's call, decoded by `callable`. */
export const OwnCall = Schema.Union([
	own('run', Run),
	own('approvals.decide', Decide),
	own('filter.describe', Describe),
	own('filter.options', Options),
	/** Never refused: what does not decode starts a conversation with the defaults. */
	own(
		'sys_conversation.start',
		Schema.Struct({ title: tolerant(Schema.String), model: tolerant(Schema.String) }).pipe(
			Schema.catchDecoding(() => Effect.succeedSome({}))
		)
	),
	own('sys_message.post', Post),
	own('sys_conversation.notify', Notify),
	own('sys_conversation.respond_now', ConversationIn),
	own('sys_conversation.stop', ConversationIn),
	own('sys_conversation.resume', ConversationIn),
	own('sys_conversation.set_model', SetModel),
	own('sys_conversation.set_agent', SetAgent),
	own('sys_message.revise', Revise),
	own('sys_message.restart', MessageIn),
	own('sys_message.dequeue', MessageIn),
	own('sys_message.reorder', Reorder),
	own('sys_message.execute_plan', ConversationIn),
	own('sys_message.discard_plan', ConversationIn),
	own('sys_message.file', FileAbout),
	own('sys_message.mark_read', ConversationIn),
	own('sys_notification.mark_read', MarkNotices),
	own('sys_message.confirm', Confirm),
	own('history.preview', RestoreTarget),
	own('history.restore', RestoreTarget)
]);
export type OwnCall = typeof OwnCall.Type;
/** The own callables whose input can be refused (starting a conversation never is). */
type RefusableCall = Exclude<OwnCall['callable'], 'sys_conversation.start'>;
type Check = readonly [input: Schema.ConstraintDecoder<unknown>, refusal: string];
const conversationFirst: Check = [ConversationIn, 'this call takes { conversation }'],
	messageFirst: Check = [MessageIn, 'this call takes { message }'];
/** Each own callable's checks of its input, in the order its sender has always met them, each with its refusal. */
const CHECKS: { readonly [C in RefusableCall]: readonly [Check, ...Check[]] } = {
	run: [
		[Run, 'run takes { automation, input, id } or { automation, runs: [{ input, id }] }']
	],
	'approvals.decide': [[Decide, 'approvals.decide takes { request_id, decision, reason? }']],
	'filter.describe': [
		[
			Schema.Struct({ model: Schema.String, text: Schema.String }),
			'filter.describe takes { model, text }'
		],
		[Describe, 'filter.describe fields are invalid']
	],
	'filter.options': [
		[Schema.Struct({ model: Schema.String }), 'filter.options takes { model }'],
		[Options, 'filter.options fields are invalid']
	],
	'sys_message.post': [
		[Post, 'sys_message.post takes { conversation, text, attachments?, mode? }']
	],
	'sys_conversation.notify': [
		conversationFirst,
		[Notify, 'sys_conversation.notify takes { conversation, text }']
	],
	'sys_conversation.respond_now': [
		[ConversationIn, 'sys_conversation.respond_now takes { conversation }']
	],
	'sys_conversation.stop': [conversationFirst],
	'sys_conversation.resume': [conversationFirst],
	'sys_conversation.set_model': [
		conversationFirst,
		[SetModel, 'sys_conversation.set_model takes { conversation, model }']
	],
	'sys_conversation.set_agent': [
		conversationFirst,
		[SetAgent, 'sys_conversation.set_agent takes { conversation, agent }']
	],
	'sys_message.revise': [messageFirst, [Revise, 'sys_message.revise takes { message, text, attachments? }']],
	'sys_message.restart': [messageFirst],
	'sys_message.dequeue': [messageFirst],
	'sys_message.reorder': [
		conversationFirst,
		[Reorder, 'sys_message.reorder takes { conversation, messages }']
	],
	'sys_message.execute_plan': [conversationFirst],
	'sys_message.discard_plan': [conversationFirst],
	'sys_message.file': [
		[FileAbout, 'sys_message.file takes { message, about: { model, id } | null }']
	],
	'sys_message.mark_read': [conversationFirst],
	'sys_notification.mark_read': [
		[MarkNotices, 'sys_notification.mark_read takes { ids } or { all: true }']
	],
	'sys_message.confirm': [[Confirm, 'sys_message.confirm takes { message, approve }']],
	'history.preview': [[RestoreTarget, 'history.preview takes { model, record, revision }']],
	'history.restore': [[RestoreTarget, 'history.restore takes { model, record, revision }']]
};
/**
 * The refusal (`invalid`, `decode`) of an own callable's input that does not decode, as its sender has always read it:
 * the first of its checks the input fails.
 */
export const ownRefusal = (callable: RefusableCall, input: unknown): string => {
	const checks = CHECKS[callable];
	return (checks.find(([schema]) => Option.isNone(Schema.decodeUnknownOption(schema)(input))) ??
		checks[0])[1];
};

// ── an integration instance's status: what a link reports and the shell draws ──
/**
 * Where an instance's link is. `pairing` is the provider asking for something; `reconnecting` is a retry after a drop
 * and is progress, not failure; `error` is the only terminal one and names its own recovery in `error`.
 */
export const InstanceState = Schema.Literals([
	'unpaired',
	'connecting',
	'pairing',
	'connected',
	'reconnecting',
	'error'
]);
export type InstanceState = typeof InstanceState.Type;
/** Operator-facing text a provider supplies: English, and each framework locale it is written in (the shell picks by locale). */
export const LocalText = Schema.Union([
	Schema.String,
	Schema.Struct({ en: Schema.String, zh: tolerant(Schema.String) })
]);
export type LocalText = typeof LocalText.Type;
/** One input a provider's setup collects. `secret` is drawn masked and never echoed back in `about`. */
export const SetupField = Schema.Struct({
	name: Schema.String,
	label: LocalText,
	secret: tolerant(Schema.Boolean),
	hint: tolerant(LocalText),
	optional: tolerant(Schema.Boolean),
	/** A choice among these values (the first is the default), instead of free text. */
	options: Schema.optionalKey(listOf(Schema.Struct({ value: Schema.String, label: LocalText })))
});
export type SetupField = typeof SetupField.Type;
/**
 * One instruction, in order. `href` is where to do it (the provider's console); `copy` a value to paste there: the
 * instance's `webhook_url`, or `redirect_url` (the host's one OAuth callback, to register with an OAuth app once).
 */
export const SetupStep = Schema.Struct({
	text: LocalText,
	href: tolerant(Schema.String),
	copy: tolerant(Schema.Literals(['webhook_url', 'redirect_url']))
});
export type SetupStep = typeof SetupStep.Type;
/**
 * How a provider is set up, as data the shell renders with no provider-named component. `kind` is what `pair`
 * takes: `form` sends `fields`; `qr`/`code` sends the optional `fields` and then shows what `pairing` publishes; `oauth`
 * sends nothing and publishes a sign-in; `none` needs nothing. A `qr`, `code` or `oauth` setup starts on Connect.
 * `webhook`: the operator pastes `about.webhook_url` into the provider.
 */
export const SetupDescription = Schema.Struct({
	kind: Schema.Literals(['form', 'qr', 'code', 'oauth', 'none']),
	steps: listOf(SetupStep).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
	fields: Schema.optionalKey(listOf(SetupField)),
	webhook: tolerant(Schema.Boolean)
});
export type SetupDescription = typeof SetupDescription.Type;
/** An ISO instant with its zone or offset. */
const ImportInstant = Schema.String.check(
	Schema.makeFilter((value: string) => /(Z|[+-]\d{2}:?\d{2})$/i.test(value) && Option.isSome(DateTime.make(value)))
);
const ImportZone = Schema.String.check(
	Schema.makeFilter((value: string) => value !== '' && Option.isSome(DateTime.zoneMakeNamed(value)))
);
/** A persisted source boundary. A missing boundary retains the instance's previous all-history behavior. */
export const ImportStart = Schema.Union([
	Schema.Struct({ kind: Schema.Literal('all') }),
	Schema.Struct({
		kind: Schema.Literal('since'),
		at: ImportInstant,
		zone: ImportZone,
		origin: Schema.Literals(['now', 'date'])
	}),
	Schema.Struct({
		kind: Schema.Literal('native'),
		selected_at: ImportInstant,
		provider: Schema.String,
		values: Schema.Record(Schema.String, Schema.String)
	})
]);
export type ImportStart = typeof ImportStart.Type;
/** The host freezes From now and resolves a selected civil day's midnight in its chosen IANA zone. */
export const ImportStartInput = Schema.Union([
	Schema.Struct({ kind: Schema.Literal('all') }),
	Schema.Struct({ kind: Schema.Literal('now'), zone: Schema.String }),
	Schema.Struct({ kind: Schema.Literal('since'), date: Schema.String, zone: Schema.String }),
	Schema.Struct({
		kind: Schema.Literal('native'),
		provider: Schema.String,
		values: Schema.Record(Schema.String, Schema.String)
	})
]);
export type ImportStartInput = typeof ImportStartInput.Type;
export const ImportStartCapability = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal('timestamp'),
		precision: Schema.optionalKey(Schema.Literal('second'))
	}),
	Schema.Struct({ kind: Schema.Literal('native'), fields: Schema.Array(SetupField) })
]);
export type ImportStartCapability = typeof ImportStartCapability.Type;
/** A provider as the shell offers it: a driver with several (WhatsApp) asks which, by `label`, first. */
export const ProviderChoice = Schema.Struct({
	id: Schema.String,
	label: LocalText,
	setup: SetupDescription,
	import_start: Schema.optionalKey(ImportStartCapability),
	/** Short catalogue name; the full registration label remains in `label`. */
	name: tolerant(LocalText),
	/** Concise catalogue description, localized by the authored surface. */
	description: tolerant(LocalText),
	/** Iconify provider mark, with a generic plug fallback when absent. */
	icon: tolerant(Schema.String),
	/** `false`: the host has no OAuth client for its sign-in (`Provider.oauth`), so it cannot connect here. */
	available: tolerant(Schema.Boolean)
});
export type ProviderChoice = typeof ProviderChoice.Type;
/**
 * One definition a member may connect (`GET /__bolt/integrations`): its providers for a member's own account
 * (`personal`) and for a workspace instance (`workspace`), each possibly empty on this host.
 */
export const IntegrationOffer = Schema.Struct({
	integration: Schema.String,
	driver: Driver,
	description: Schema.String,
	/** It carries a conversation, so an envoy can answer on it. */
	conversation: Schema.Boolean,
	personal: listOf(ProviderChoice),
	workspace: listOf(ProviderChoice)
});
export type IntegrationOffer = typeof IntegrationOffer.Type;
/** A connected instance's test send: a short test message, to the handle the operator types in `to` (absent: to the connected account itself). */
export const TestSend = Schema.Struct({ to: Schema.optionalKey(SetupField) });
export type TestSend = typeof TestSend.Type;
/** What the provider wants from the operator, when it wants something. `value` is the payload to draw (a QR, a code). */
export const Pairing = Schema.Struct({
	/**
	 * `qr`: scan `value`; `code`: show `value` for the operator to type; `credential`: collect a secret and send it back;
	 * `form`: collect `fields` and send them back as one object; `oauth`: open `value` (the provider's authorize URL) in a
	 * popup, where the operator signs in; the provider's redirect lands on the host's one OAuth callback.
	 */
	kind: Schema.Literals(['qr', 'code', 'credential', 'form', 'oauth']),
	value: Schema.NullOr(Schema.String).pipe(
		Schema.catchDecoding(() => Effect.succeedSome(null)),
		Schema.withDecodingDefaultKey(Effect.succeed(null))
	),
	/** The provider's own deadline for `value` (ISO), when it publishes one. */
	expires_at: tolerant(Schema.String),
	/** What to call the field, for `credential` (a Telegram bot token is not "credential"); `oauth`: the sign-in button. */
	label: tolerant(Schema.String),
	/** `form`: what to collect, sent back as `{ [name]: value }`. */
	fields: Schema.optionalKey(listOf(SetupField))
});
export type Pairing = typeof Pairing.Type;
const LinkStatusFields = {
	state: InstanceState,
	/** The verified identity it is connected as (a number with its device suffix stripped, a mailbox, a bot). */
	account: tolerant(Schema.NullOr(Schema.String)),
	/** Operator-readable context for a non-terminal state. */
	detail: tolerant(Schema.String),
	/** The recovery `error` needs, operator action. */
	error: tolerant(Schema.String),
	/** A terminal error's kind (`replaced`, `loggedOut`, `forbidden`, …), for a notice that names its action. */
	code: tolerant(Schema.String),
	/** The provider's last disconnect (its code, tag and instant). */
	last_disconnect: Schema.optionalKey(Schema.Json),
	/**
	 * Facts the connected view shows generically: `webhook_url`, `address` (email), `botName`, `workspace`/`team` (Slack),
	 * `guilds`/`inviteUrl` (Discord), `account` (WeChat), `from` (Twilio number).
	 */
	about: Schema.optionalKey(Schema.Json)
};
/** What a link reports of itself (`DriverOpen.status`): where it is, as whom, and the facts the connected view shows. */
export const LinkStatus = Schema.Struct(LinkStatusFields);
export type LinkStatus = typeof LinkStatus.Type;
/**
 * One instance as the shell shows it (`GET`/`stream` of `/__bolt/integrations/<instance>`): its link's status and the
 * host's choices. A malformed member is dropped; a malformed state, instance or driver refuses the whole answer.
 */
export const InstanceStatus = Schema.Struct({
	...LinkStatusFields,
	instance: Schema.String,
	integration: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(''))),
	driver: Driver,
	/** A credential is stored, so reconnecting needs no new pairing. */
	stored: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
	/** When `state` was entered. */
	since: tolerant(Schema.String),
	pairing: Schema.optionalKey(
		Schema.NullOr(Pairing).pipe(Schema.catchDecoding(() => Effect.succeedSome(null)))
	),
	/** The active provider's id (`twilio` | `baileys` for WhatsApp), once one is chosen. */
	provider: tolerant(Schema.String),
	/** What the driver can be set up with on this host; the shell asks which when there are several. */
	providers: Schema.optionalKey(listOf(ProviderChoice)),
	import_start: Schema.optionalKey(Schema.NullOr(ImportStart)),
	/** Present when the connected provider can send a test message: the shell offers Test, asking for `to` when it names one. */
	test: tolerant(TestSend)
});
export type InstanceStatus = typeof InstanceStatus.Type;

// ── sessions and host operations ──
/** `POST /__bolt/session/code`: where to send a sign-in code, and by which channel for a mobile number. */
export const SessionCode = Schema.Struct({
	address: Schema.String,
	via: Schema.optionalKey(Schema.Literals(['sms', 'whatsapp']))
});
/** `POST /__bolt/session/{code,verify,signout,invitation}`. */
export const SessionRequest = Schema.Union([
	Schema.Struct({ path: Schema.Literal('code'), body: SessionCode }),
	Schema.Struct({
		path: Schema.Literal('verify'),
		body: Schema.Struct({ address: Schema.String, code: Schema.String })
	}),
	Schema.Struct({ path: Schema.Literal('signout'), body: Schema.optionalKey(Schema.Undefined) }),
	Schema.Struct({ path: Schema.Literal('invitation'), body: Schema.Struct({ id: Schema.String }) })
]);
export type SessionRequest = typeof SessionRequest.Type;
/** `verify` answers the user (and sets the session cookie); the others answer `null`. */
export const SessionResponse = Schema.Union([
	Schema.Struct({ value: Schema.NullOr(Schema.Struct({ user: Schema.String })) }),
	WireError
]);
export type SessionResponse = typeof SessionResponse.Type;
/** A host channel operation (a host's private socket, or bolt-server's MAC-signed `POST /__bolt/ops`): `host.ping`, `session.mint`, `founder.bootstrap`, … */
export const HostOperation = Schema.Struct({
	op: Schema.String,
	input: Schema.Record(Schema.String, Schema.Json),
	runId: Schema.optionalKey(Schema.String)
});
export type HostOperation = typeof HostOperation.Type;
export const HostOperationResult = Schema.Union([Schema.Struct({ value: Schema.Json }), WireError]);
export type HostOperationResult = typeof HostOperationResult.Type;

// ── `norbital.template.json`: a template's catalogue entry ──
const Copy = Schema.String.check(Schema.isPattern(/\S/));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
/** What the template repositories' gate checks, the website draws and a host's template picker lists. */
export const TemplateManifest = Schema.Struct({
	schema_version: Schema.Literal(1),
	/** The workspace handle: the tenant id a host provisions it as (not the directory name). */
	key: Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/)),
	name: Copy,
	industry: Copy,
	description: Copy,
	visibility: Schema.Literals(['public', 'unlisted']),
	/** Matches the source (the gate counts models, apps and automations). */
	counts: Schema.Struct({ models: Count, apps: Count, automations: Count }),
	tags: Schema.Array(Schema.String),
	name_zh: Schema.optionalKey(Schema.NonEmptyString),
	description_zh: Schema.optionalKey(Schema.NonEmptyString)
});
export type TemplateManifest = typeof TemplateManifest.Type;
