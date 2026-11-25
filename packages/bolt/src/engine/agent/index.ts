// The agent engine: a turn is a loop over a conversation's rows. Each step claims the queued inputs
// (a steer joins at the next step and acts as its own sender), builds the context, makes one model request (60 s to its
// first byte, then the 20 s idle wall) and runs the tool calls it asks for as the actor. A turn ends on a reply with no tool calls, a confirmation
// card or a stop, or at the step cap; guards end it earlier when it makes no progress. An executed plan is checked by a verifier on the
// turn's own cached prefix; a sub-agent is a
// child conversation run under the delegating turn's `as`, never wider. Hosts drive `drain`; nothing here names a host.
// A claimed turn holds a three-minute lease its heartbeat renews and queues the platform run `agent.turn`, so a turn
// whose process died is taken over once the lease lapses, and never runs twice at once.
import { Port } from '@norbital-ai/host-api';
import { sha256_hex } from '@norbital-ai/store';
import {
	Clock,
	Config,
	ConfigProvider,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FiberMap,
	FiberSet,
	Layer,
	Option,
	PubSub,
	Redacted,
	Schema
} from 'effect';
import type { Json } from '../../decl/values.ts';
import { BoltError } from '../../protocol/errors.ts';
import type { PageResult } from '../../protocol/schema.ts';
import { Audit } from '../audit.ts';
import type { Authority } from '../contracts.ts';
import { mark as markMessage, post as postMessage, stableId } from '../conversations/store.ts';
import { CapturedResult, capturePiece, nativeCommit } from '../db/captured.ts';
import { sql } from '../db/sql.ts';
import { TenantDb } from '../db/tenant-db.ts';
import { envoySpec } from '../envoys/spec.ts';
import type { EngineError } from '../errors.ts';
import { Authorities } from '../identity/actor.ts';
import { credentials } from '../integrations/credentials.ts';
import type { EngineManifest } from '../manifest.ts';
import { makeParking } from '../parking.ts';
import {
	Ai,
	Bundler,
	Convert,
	Files,
	Geo,
	GuestIsolates,
	Http,
	Images,
	Logs,
	Mcp
} from '../ports.ts';
import { bindingsAt } from '../query/reader.ts';
import { runPiece } from '../runs/rows.ts';
import { Secrets } from '../secrets.ts';
import {
	Agents as AgentsTag,
	Approvals,
	Automations,
	Callables,
	HostIdentity,
	Links,
	Live,
	Manifest,
	Reads,
	RunEnds,
	RunHandlers,
	Wake,
	type AgentsShape,
	type SystemTask
} from '../services.ts';
import { Chain } from '../write/sql.ts';
import { servesModel } from './ai.ts';
import { attachmentsFor, file_attachments } from './attachments.ts';
import { makeConfirm } from './confirm.ts';
import { makeAgentLifecycle } from './lifecycle.ts';
import { mcpServers } from './mcp.ts';
import { makeAgentStore } from './messages.ts';
import { MessageQueue, messageQueue, SCHEDULED_RUN } from './queue.ts';
import { AgentRefusal, TASK, type As, type MessageRow, type Plan } from './schema.ts';
import { agentSettings, overTaskLimit } from './settings.ts';
import {
	AgentDrains,
	AgentHost,
	DEFAULT_MODEL,
	formatExportTranscript,
	j,
	type AgentConfig,
	type DrainOptions
} from './shared.ts';
import type { Validators } from './tools.ts';
import { makeTurnRunner } from './turn.ts';
import { makeAuthorityResolver, makeWorkspaceSkills } from './turn-context.ts';
import { TURN_RUN, TurnHandlers } from './turns.ts';

export { infer_facility } from './ai.ts';
export { mcpServers } from './mcp.ts';
export { type As } from './schema.ts';
export type { AttachmentPort } from './tools.ts';
export {
	AGENT_LIMITS,
	AgentDrains,
	AgentHost,
	ANSWERED,
	approvedCalls,
	approvedPageSession,
	callKey,
	checkFailing,
	FIXED,
	NUDGE,
	STREAM_FLUSH_MS,
	TYPING_REFRESH_MS,
	type AgentConfig,
	type AgentEngine,
	type AgentHostConfig
} from './shared.ts';

export const agents = Effect.fn('Agents.make')(function* (config: AgentConfig) {
	const e = config.engine,
		m: EngineManifest = e.manifest,
		db = e.db,
		mcp_port = yield* Mcp,
		logs = yield* Logs;
	const manifestHash = sha256_hex(JSON.stringify(m));
	// a parent's id per finished sub-agent; a subscriber past this many unread drops the oldest, and re-reads the table
	const reports = yield* PubSub.sliding<string>(256);
	const authorities = new Authorities(m, 'agent', { remember: true });
	const workspaceSkills = makeWorkspaceSkills(m, config.skill_files);
	const resolve = makeAuthorityResolver(config, authorities, db, e.live.publish);
	const running = yield* FiberMap.make<
		string,
		{ ran: boolean; reply: MessageRow | null },
		EngineError
	>();
	/** Sub-agent runs and the parent turns their reports start: detached from any one turn, ended with the service. */
	const detached = yield* FiberSet.make<unknown, never>();
	/** Runs a live turn job watches here (`runJob`): their ends reach the agent through it, the rest through `runsEnded`. */
	const watched = new Set<string>();
	/** The conversations inside a step: a planned close waits for none, and holds each turn at its next step. */
	const stepping = makeParking();
	/** The ingests this engine runs (`ToolContext.reading`) and its raw-schema validators: the engine's, never the process's. */
	const reading = new Set<string>();
	const validators: Validators = new WeakMap();

	/** Runs a conversation once its running turn (if any) ends, so an input that landed as it finished is not left queued. */
	const kick = (id: string): Effect.Effect<void> =>
		Effect.gen(function* () {
			const existing = yield* FiberMap.get(running, id);
			if (Option.isSome(existing)) {
				yield* queue.ring(id);
				yield* Fiber.await(existing.value);
			}
			// the turn took it: a drain now would only flash the conversation as running
			if (yield* queue.waiting(id)) yield* drain(id);
		}).pipe(Effect.tapCause(Effect.logWarning), Effect.ignore);

	const kickDetached = (id: string) => FiberSet.run(detached, kick(id)).pipe(Effect.asVoid);

	const store = makeAgentStore({
		db,
		publish: e.live.publish,
		bindings: config.bindings,
		announce: config.announce,
		kick: kickDetached
	});

	const queue = yield* messageQueue({
		db,
		publish: e.live.publish,
		now: config.bindings.pipe(Effect.map((b) => b.now)),
		announce: (at) => config.announce?.(at) ?? Effect.void,
		start: kickDetached
	});

	/** Idle only when nothing is queued; otherwise the turn continues. */
	const settle = Effect.fn('Agents.settle')(function* (id: string) {
		if (yield* queue.finished(id)) return false;
		return (yield* store.idle(id, true)) === 1;
	});

	const drain: (
		id: string,
		options?: DrainOptions
	) => Effect.Effect<{ ran: boolean; reply: MessageRow | null }, EngineError> = Effect.fn(
		'Agents.drainManaged'
	)(function* (id: string, options: DrainOptions = {}) {
		const existing = yield* FiberMap.get(running, id);
		if (Option.isSome(existing)) {
			yield* queue.ring(id);
			return { ran: false, reply: null };
		}
		const fiber = yield* FiberMap.run(
			running,
			id,
			Effect.scoped(drainTurn(id, options)).pipe(Effect.onInterrupt(() => store.release(id))),
			{
				onlyIfMissing: true
			}
		);
		// a stopped sub-agent's turn is interrupted (stop removes it from `running`); its stopper tells the parent
		const exit = yield* Fiber.await(fiber);
		if (Exit.isFailure(exit) || exit.value.ran)
			yield* lifecycle
				.reportUp(id, Exit.isSuccess(exit) ? exit.value.reply : null)
				.pipe(Effect.tapCause(Effect.logWarning), Effect.ignore);
		return yield* exit;
	});

	const lifecycle = makeAgentLifecycle({
		config,
		store,
		detached,
		watched,
		reports,
		kick,
		drain
	});

	// a turn running in any generation reads the stop at its next step; stopping it here tells its parent, once
	const stop = Effect.fn('Agents.stop')(function* (id: string) {
		const was = yield* store.convChanged(
			sql(
				`UPDATE sys_conversation AS c SET status = 'stopped', lease_until = NULL, revision = revision + 1, updated_at = now() WHERE id = $1 AND status = 'running'`,
				id
			)
		);
		if (was.length === 0) yield* store.setConv(id, `status = 'stopped', lease_until = NULL`);
		yield* store.cancelQueued(id);
		yield* FiberMap.remove(running, id);
		if (was.length > 0)
			yield* lifecycle
				.reportUp(id, null, true)
				.pipe(Effect.tapCause(Effect.logWarning), Effect.ignore);
	});

	const drainTurn = makeTurnRunner({
		config,
		mcpPort: mcp_port,
		logs,
		manifestHash,
		workspaceSkills,
		resolve,
		store,
		queue,
		detached,
		watched,
		stepping,
		reading,
		validators,
		reports,
		settle,
		steer: lifecycle.steer,
		kick,
		drain,
		stop
	});

	const confirm = makeConfirm({
		config,
		mcpPort: mcp_port,
		logs,
		workspaceSkills,
		store,
		queue,
		resolve,
		detached,
		watched,
		reading,
		validators,
		reports,
		steer: lifecycle.steer,
		kick,
		drain,
		stop
	});

	const attachments = (member: string, refs: readonly Json[]) => attachmentsFor(db, member, refs);
	const api = {
		start: store.start,
		post: queue.post,
		kick,
		queue,
		ambient: store.ambient,
		notify: Effect.fn('Agents.notify')(function* (o: {
			conversation: string;
			text: string;
			id: string;
			as?: As | undefined;
		}) {
			yield* store.conversation(o.conversation);
			const chain = new Chain();
			const [row] = yield* store.messageStatement(
				chain,
				postMessage(
					chain,
					{
						conversation: o.conversation,
						role: 'system',
						content: { text: o.text },
						text: o.text,
						state: 'queued',
						mode: 'agent',
						as: o.as ?? null,
						meta: { tag: 'note', notice: o.id }
					},
					`NOT EXISTS (SELECT 1 FROM sys_message WHERE conversation = ${chain.p(o.conversation)} AND meta->>'notice' = ${chain.p(o.id)})`
				)
			);
			if (row === undefined) return false;
			yield* FiberSet.run(detached, kick(o.conversation));
			return true;
		}),
		task: Effect.fn('Agents.task')(function* (o: SystemTask) {
			// one conversation per run: a repeated start answers it and starts nothing
			const id = stableId(TASK, o.run);
			const existing = yield* e.db.rows(
				Schema.Struct({ id: Schema.String }),
				sql('SELECT id FROM sys_conversation WHERE id = $1', id)
			);
			if (existing.length > 0) return id;
			const settings = yield* agentSettings(e.db);
			// an administrator may turn either kind off: the host's own (no policies named) or an automation's
			if (!(o.policies === undefined ? settings.system.improve : settings.system.automations))
				return yield* BoltError.make(
					'forbidden',
					'admission',
					o.policies === undefined
						? 'An administrator has not turned automatic improvement on.'
						: 'An administrator has turned off agents that automations start.'
				);
			if ((yield* overTaskLimit(e.db, settings, null)) !== null)
				return yield* BoltError.make(
					'forbidden',
					'admission',
					"The workspace's monthly spending limit for system agents is reached."
				);
			yield* store.start({ id, kind: TASK, title: o.description.slice(0, 80) });
			yield* queue.post({
				conversation: id,
				as: { policies: o.policies ?? settings.system.policies, run: o.run },
				text: o.prompt,
				author: 'system',
				files: o.files
			});
			yield* FiberSet.run(detached, kick(id));
			return id;
		}),
		gaveUp: lifecycle.gaveUp,
		park: stepping.park,
		drain,
		conversation: store.conversation,
		transcript: store.transcript,
		attachments,
		stop,
		resume: Effect.fn('Agents.resume')(function* (id: string) {
			yield* store.conversation(id);
			// A follow-up may already have restarted it while the client still showed Resume.
			const reopened = yield* store.convChanged(
				sql(
					`UPDATE sys_conversation AS c SET status = 'idle', revision = revision + 1, updated_at = now()
					 WHERE id = $1 AND status = 'stopped'`,
					id
				)
			);
			if (reopened.length > 0) {
				const rows = yield* store.transcript(id),
					lastReply =
						rows.findLast((r) => r.role === 'assistant' && r.meta?.tag === 'reply')?.seq ?? 0;
				const objective = rows.findLast((r) => r.role === 'user' && r.state === 'consumed');
				const cancelled = rows.filter(
					(r) => r.role === 'user' && r.state === 'cancelled' && r.seq > lastReply
				);
				const as = rows.findLast((r) => r.as !== null)?.as ?? null;
				const text = [
					'The person resumed this conversation after stopping it; continue the stopped work if it is still wanted.',
					objective?.text == null ? '' : `Stopped request: ${objective.text}`,
					...cancelled.map((r) => `Not yet handled: ${r.text ?? ''}`)
				]
					.filter((x) => x !== '')
					.join('\n');
				if (as !== null) yield* store.queuedNote(id, as, text);
			}
			return yield* drain(id);
		}),
		set_model: Effect.fn('Agents.set_model')(function* (id: string, model: string) {
			if (
				config.ai !== undefined &&
				!(yield* servesModel(config.ai, model).pipe(
					Effect.mapError((error) => BoltError.make(error.kind, 'facility', error.message, error))
				))
			)
				return yield* new AgentRefusal({ message: `the host runs no model '${model}'` });
			yield* store.setConv(id, 'model = $2', model);
		}),
		revise: queue.revise,
		restart: queue.restart,
		dequeue: queue.remove,
		reorder: queue.reorder,
		turnRun: lifecycle.turnRun,
		execute_plan: Effect.fn('Agents.execute_plan')(function* (id: string, as: As) {
			const conv = yield* store.conversation(id);
			if (conv.plan === null)
				return yield* new AgentRefusal({ message: 'there is no plan to execute' });
			const checkpoint = yield* db.value(
				Schema.Number,
				sql(`SELECT coalesce(max(seq), 0)::int AS s FROM sys_message WHERE conversation = $1`, id)
			);
			yield* store.setConv(
				id,
				'plan = $2::jsonb',
				j({ ...conv.plan, status: 'active', checkpoint, verdicts: 0 } satisfies Plan)
			);
			yield* queue.post({ conversation: id, as, text: 'Execute the plan.', mode: 'agent' });
			return yield* drain(id);
		}),
		discard_plan: Effect.fn('Agents.discard_plan')(function* (id: string) {
			yield* store.setConv(id, 'plan = NULL');
		}),
		/**
		 * Deletes an in-app conversation for good, by its owner: its turn stops, its messages, its sub-agents' and their
		 * queued turns go, and the removal reaches live transcripts and lists. The files it holds stay with their records.
		 */
		archive: Effect.fn('Agents.archive')(function* (id: string, archived: boolean, by: Authority) {
			const conv = yield* store.conversation(id);
			if (conv.integration !== null || by.actor.kind !== 'member' || conv.owner !== by.actor.id)
				return yield* new AgentRefusal({
					message: 'Only its owner archives an in-app conversation.'
				});
			yield* store.setConv(id, archived ? 'archived_at = now()' : 'archived_at = NULL');
		}),
		remove: Effect.fn('Agents.remove')(function* (id: string, by: Authority) {
			const conv = yield* store.conversation(id);
			if (conv.integration !== null || by.actor.kind !== 'member' || conv.owner !== by.actor.id)
				return yield* new AgentRefusal({
					message: 'Only its owner deletes an in-app conversation.'
				});
			const children = yield* db.rows(
				Schema.Struct({ id: Schema.String }),
				sql('SELECT id FROM sys_conversation WHERE parent = $1', id)
			);
			for (const one of [id, ...children.map((child) => child.id)])
				yield* FiberMap.remove(running, one);
			yield* store.changed(
				sql(
					'DELETE FROM sys_message m WHERE conversation IN (SELECT id FROM sys_conversation WHERE id = $1 OR parent = $1)',
					id
				)
			);
			const chain = new Chain();
			chain.params.push(id);
			runPiece(
				chain,
				'unqueued',
				`DELETE FROM sys_run WHERE automation = '${TURN_RUN}' AND state = 'queued'
				AND input->>'conversation' IN (SELECT id FROM sys_conversation WHERE id = $1 OR parent = $1)`
			);
			capturePiece(
				chain,
				'removed',
				'sys_conversation',
				'DELETE FROM sys_conversation WHERE id = $1 OR parent = $1'
			);
			yield* nativeCommit(db.write, e.live.publish, chain, CapturedResult);
		}),
		set_agent: Effect.fn('Agents.set_agent')(function* (id: string, agent: string) {
			if (agent !== 'workspace' && (yield* envoySpec(db, agent)) === undefined)
				return yield* new AgentRefusal({ message: `there is no agent '${agent}'` });
			yield* store.setConv(id, 'envoy = $2', agent === 'workspace' ? null : agent);
		}),
		file: Effect.fn('Agents.file')(function* (
			messageId: string,
			about: { model: string; id: string } | null
		) {
			const chain = new Chain();
			yield* store.messageStatement(chain, markMessage(chain, messageId, { about }));
		}),
		mark_read: Effect.fn('Agents.mark_read')(function* (id: string, member: string) {
			yield* store.convChanged(
				sql(
					`UPDATE sys_conversation c SET read = read || jsonb_build_object($2::text, (SELECT coalesce(max(seq), 0) FROM sys_message WHERE conversation = $1)) WHERE id = $1`,
					id,
					member
				)
			);
		}),
		claim_page_action: Effect.fn('Agents.claim_page_action')(function* (messageId: string) {
			const rows = yield* store.changed(
				sql(
					`UPDATE sys_message m SET content = jsonb_set(content, '{result,pageClaim}', 'true'::jsonb, true)
					WHERE id = $1 AND role = 'tool' AND copied_from IS NULL AND content->'result'->'pageClaim' IS NULL`,
					messageId
				)
			);
			return rows.length > 0;
		}),
		page_result: Effect.fn('Agents.page_result')(function* (
			messageId: string,
			result: PageResult
		) {
			const answered = yield* store.changed(
				sql(
					`UPDATE sys_message m SET content = jsonb_set(content, '{result,page_result}', $2::jsonb, true)
					WHERE m.id = $1 AND m.role = 'tool' AND m.copied_from IS NULL AND jsonb_typeof(m.content->'result') = 'object'`,
					messageId,
					JSON.stringify(result)
				)
			);
			for (const row of answered) {
				const waiting = store.pageWaits.get(row.conversation);
				if (waiting !== undefined) yield* Deferred.succeed(waiting, undefined);
			}
		}),
		confirm,
		/** The agent's live surface: the model classes and the MCP servers this actor may use. */
		surface: (a: Authority) => ({ models: config.ai?.models ?? [], mcp: mcpServers(m, a) }),
		models: Effect.fn('Agents.models')(function* () {
			const listed = (listing: Ai['Service']['catalog'] | undefined) =>
				listing === undefined
					? Effect.succeed(undefined)
					: listing.pipe(Effect.catch(() => Effect.succeed(undefined)));
			const cat = yield* listed(config.ai?.catalog);
			return {
				...(cat ?? {
					models: (config.ai?.models ?? []).map((id) => ({ id, label: id })),
					default: DEFAULT_MODEL
				}),
				deciders: (yield* listed(config.ai?.deciders)) ?? { models: [], default: '' }
			};
		}),
		exportTranscript: Effect.fn('Agents.exportTranscript')(function* (id: string) {
			const conv = yield* store.conversation(id);
			const rows = yield* store.transcript(id);
			return formatExportTranscript(conv, rows);
		})
	};
	e.db.owe(lifecycle.resumeSettled);
	e.db.owe(store.jobsDied);
	if (e.runEnds !== undefined) {
		const ends = yield* PubSub.subscribe(e.runEnds);
		yield* FiberSet.run(
			detached,
			Effect.forever(
				PubSub.take(ends).pipe(
					Effect.flatMap((ids) =>
						lifecycle.runsEnded(ids).pipe(Effect.tapCause(Effect.logWarning), Effect.ignore)
					)
				)
			)
		);
	}
	return api;
});

export type Agents = Effect.Success<ReturnType<typeof agents>>;

export const AgentsLive = Layer.effectContext(
	Effect.gen(function* () {
		const manifest = yield* Manifest,
			db = yield* TenantDb,
			live = yield* Live,
			calls = yield* Callables,
			automations = yield* Automations,
			reads = yield* Reads,
			approvals = yield* Approvals;
		const ai = yield* Ai,
			files = yield* Files,
			images = yield* Images,
			convert = yield* Convert,
			runEnds = yield* RunEnds,
			guest = yield* GuestIsolates,
			http = yield* Http,
			bundler = yield* Effect.serviceOption(Bundler),
			identity = yield* Effect.serviceOption(HostIdentity),
			audit = yield* Audit,
			geo = yield* Geo,
			wake = yield* Wake,
			turnHandlers = yield* TurnHandlers,
			runHandlers = yield* RunHandlers,
			links = yield* Effect.serviceOption(Links),
			host = yield* AgentHost;
		const bindings = Clock.currentTimeMillis.pipe(
			Effect.map((now) => bindingsAt(now, manifest.workspace.tz))
		);
		const typing =
			host.typing ??
			(Option.isSome(links)
				? (integration: string, thread: string, on: boolean) =>
						links.value
							.typing(integration, thread, on)
							.pipe(Effect.tapCause(Effect.logWarning), Effect.ignore)
				: undefined);
		const secrets = yield* Secrets;
		const sealed = yield* credentials(db, secrets);
		// The MCP server's secret names resolve through the workspace's sealed secrets, not the host process environment.
		const mcp = host.mcp ?? {
			secret: (name: string) =>
				Config.option(Config.Redacted(name)).pipe(
					Effect.provideService(ConfigProvider.ConfigProvider, secrets.config),
					Effect.map((value) => Option.getOrUndefined(Option.map(value, Redacted.value))),
					Effect.mapError(Port.failure('mcp.configuration'))
				)
		};
		const api = yield* agents({
			...host,
			mcp,
			...(typing === undefined ? {} : { typing }),
			engine: {
				...Option.match(identity, { onNone: () => ({}), onSome: (identity) => ({ identity }) }),
				manifest,
				db,
				live,
				calls,
				automations,
				read: reads.run,
				approvals,
				...(audit.mode === 'disabled' ? {} : { audit }),
				files,
				images,
				convert,
				runEnds,
				guest,
				http,
				credentials: sealed,
				...Option.match(bundler, { onNone: () => ({}), onSome: (b) => ({ bundler: b }) })
			},
			ai,
			bindings,
			announce: wake.at,
			attachments: host.attachments ?? file_attachments(db, files, images),
			media: { files, images },
			geocoder: host.geocoder ?? geo
		});
		yield* turnHandlers.register('Agent', api.drain);
		yield* turnHandlers.tasks(api.task);
		const handlers = {
			[TURN_RUN]: (input: Json) =>
				api.turnRun(input, (conversation, envoy) =>
					turnHandlers.drain(conversation, envoy ? 'Envoy' : 'Agent')
				),
			[SCHEDULED_RUN]: api.queue.due
		};
		yield* runHandlers.register(handlers, {
			[TURN_RUN]: { attempts: 3, backoff: '10s' },
			[SCHEDULED_RUN]: { attempts: 3, backoff: '10s' }
		});
		const service: AgentsShape = {
			...api,
			handlers,
			attachments: api.attachments,
			revise: (id: string, text: string, by?: Authority, attachments?: readonly Json[]) =>
				api.revise(id, text, by, attachments).pipe(Effect.map(Option.fromNullishOr)),
			models: api.models()
		};
		return Context.make(AgentsTag, service).pipe(
			Context.add(AgentDrains, { drain: api.drain }),
			Context.add(MessageQueue, api.queue)
		);
	})
);
