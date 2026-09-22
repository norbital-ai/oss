import { Clock, Effect, Option, Result, Schema } from 'effect';
import {
	EffectId,
	PluginTrustedContext,
	type CommandContract,
	type DispatchResponse,
	type Invocation
} from '@norbital-ai/bolt-protocol';
import * as AccessControl from '#lib/runtime/access/access-control.js';
import * as SystemPrincipal from '#lib/runtime/access/system-principal.js';
import * as Identity from '#lib/runtime/identity/identity.js';
import * as RateLimits from '#lib/runtime/rate-limits.js';
import * as TaskQueue from '#lib/runtime/tasks/tasks.js';
import { answerAppRequest } from '#lib/runtime/pwa.js';
import { answerApiRequest, apiSegments } from '#lib/runtime/open-api.js';
import {
	flushAll,
	invocationAnnotations,
	loggerFor,
	makeSink,
	recordSettled,
	Sink
} from '#lib/runtime/telemetry.js';
import * as Workspace from '#lib/runtime/workspace.js';
import { DispatchError } from '#lib/runtime/workspace.js';
import { Secrets } from '#lib/runtime/secrets/secrets.js';
import {
	decodeUnknownSchema,
	isRecord as isObject,
	isString,
	JsonObject
} from '#lib/schema-decode.js';
import {
	assertCommandNamespace,
	resolveCommand,
	type CommandBinding,
	type ExecutionContext,
	type InvocationOrigin
} from './commands.js';

const MintedIdentityFields = [
	'subject',
	'actor',
	'tenantId',
	'impersonatedTeam',
	'policies'
] as const;

const json = (value: Schema.Json): DispatchResponse => ({ status: 200, headers: {}, value });

const credentialFromHeaders = (
	headers: Readonly<Record<string, ReadonlyArray<string>>>
): string | undefined => {
	const authorization = Object.entries(headers).find(
		([name]) => name.toLowerCase() === 'authorization'
	)?.[1][0];
	if (authorization !== undefined) return authorization.replace(/^Bearer\s+/i, '');
	const cookie = Object.entries(headers)
		.find(([name]) => name.toLowerCase() === 'cookie')?.[1]
		.join(';');
	return cookie
		?.split(';')
		.map((part) => part.trim())
		.find((part) => part.startsWith('bolt_session='))
		?.slice('bolt_session='.length);
};

const impersonatedTeamFromHeaders = (
	headers: Readonly<Record<string, ReadonlyArray<string>>>
): string | undefined => {
	const value = Object.entries(headers)
		.find(([name]) => name.toLowerCase() === 'x-colony-impersonated-team')?.[1][0]
		?.trim();
	return value === undefined || value === '' ? undefined : value;
};

const rateLimitAddress = (payload: unknown): string | undefined => {
	if (!isObject(payload)) return undefined;
	const address = Reflect.get(payload, 'address');
	const email = Reflect.get(payload, 'email');
	const value = isString(address) ? address : isString(email) ? email : undefined;
	return value === undefined || value.trim() === '' ? undefined : value;
};

const jsonObjectOf = (input: unknown): Readonly<Record<string, Schema.Json>> | undefined => {
	const decoded = Schema.decodeUnknownResult(JsonObject)(input);
	return Result.isFailure(decoded) ? undefined : decoded.success;
};

const mintedClaim = (input: unknown): string | undefined => {
	const fields = jsonObjectOf(input);
	return fields === undefined ? undefined : MintedIdentityFields.find((field) => field in fields);
};

const pluginReadResource = (input: unknown, fallback: string): string => {
	const collection = jsonObjectOf(input)?.['collection'];
	return isString(collection) && collection.length > 0 ? collection : fallback;
};

const mintedClaimDenied = (tag: 'Plugin' | 'Task', resource: string, claimed: string) =>
	new AccessControl.AccessDenied({
		action: 'authenticate',
		resource,
		reason: `a ${tag} invocation carries no credential, so the ${claimed} its payload claims is refused`
	});

const stripMintedIdentityFields = (input: unknown): unknown => {
	const fields = jsonObjectOf(input);
	if (fields === undefined) return input;
	const stripped: Record<string, Schema.Json> = { ...fields };
	for (const field of MintedIdentityFields) delete stripped[field];
	return stripped;
};

const commandBudgetKey = (contract: CommandContract): string => contract.budgetKey ?? contract.name;

const invalidInput = () =>
	new DispatchError({
		code: 'invalid_input',
		message: 'Command input did not match its protocol contract'
	});

const invalidOutput = (name: string, reason: string) =>
	new DispatchError({
		code: 'invalid_command_output',
		message: `${name} returned an undeclared ${reason}`
	});

const decodeInput = <E>(binding: CommandBinding<E>, value: unknown) =>
	(
		decodeUnknownSchema(binding.contract.input, value) as Effect.Effect<
			Schema.Schema.Type<(typeof binding)['contract']['input']>,
			Schema.SchemaError
		>
	).pipe(Effect.mapError(invalidInput));

/**
 * Handlers and origin rules run under the invocation layer. Their `R` is that layer; the binding
 * type cannot name it without collapsing every caller to `unknown`.
 */
const providedEffect = <A, E>(effect: Effect.Effect<A, E, unknown>): Effect.Effect<A, E> =>
	effect as Effect.Effect<A, E>;

const validateOutput = Effect.fn('Bolt.validateCommandOutput')(function* <E>(
	binding: CommandBinding<E>,
	response: DispatchResponse
) {
	const declared = binding.contract.responses.find(
		(candidate) => candidate.status === response.status
	);
	if (declared === undefined)
		return yield* invalidOutput(binding.contract.name, `status ${response.status}`);
	const headers = yield* (
		decodeUnknownSchema(declared.headers, response.headers) as Effect.Effect<
			Schema.Schema.Type<(typeof declared)['headers']>,
			Schema.SchemaError
		>
	).pipe(Effect.mapError(() => invalidOutput(binding.contract.name, 'header shape')));
	const value = yield* (
		decodeUnknownSchema(declared.value, response.value) as Effect.Effect<
			Schema.Schema.Type<(typeof declared)['value']>,
			Schema.SchemaError
		>
	).pipe(Effect.mapError(() => invalidOutput(binding.contract.name, 'response value')));
	return { ...response, headers, value } as DispatchResponse;
});

/** Equal without an early exit, so a guess learns nothing from how long the refusal took. */
const sameSecret = (left: string, right: string): boolean => {
	let difference = left.length ^ right.length;
	for (let index = 0; index < left.length; index++)
		difference |= left.charCodeAt(index) ^ right.charCodeAt(index % Math.max(right.length, 1));
	return difference === 0;
};

/**
 * The principal a declared API key names, when the credential is one.
 *
 * Tried only after the session store refused it, so a person's session never pays for the vault
 * reads. A key shorter than 24 characters is never accepted: it is a password, not a key.
 */
const apiKeySubject = Effect.fn('Bolt.apiKeySubject')(function* (
	effectId: EffectId,
	credential: string,
	tenantId: Invocation['scope']['tenantId']
) {
	const variables = (yield* Workspace.Service).definition.environment?.variables ?? {};
	// Optional rather than required: a required vault would put its service in the exported
	// dispatcher's type, which the declaration emitter cannot spell.
	const secrets = yield* Effect.serviceOption(Secrets.Service);
	if (Option.isNone(secrets)) return undefined;
	for (const [name, declaration] of Object.entries(variables)) {
		if (declaration.apiKey === undefined) continue;
		const value = yield* secrets.value.read(effectId, name).pipe(Effect.orElseSucceed(() => null));
		if (value !== null && value.length >= 24 && sameSecret(value, credential))
			return {
				userId: `api:${name}`,
				tenantId: String(tenantId),
				teamPath: [],
				policies: [...declaration.apiKey.policies],
				admin: false
			} satisfies Identity.Subject;
	}
	return undefined;
});

const resolveSession = Effect.fn('Bolt.resolveSession')(function* (
	effectId: EffectId,
	credential: string | undefined,
	tenantId: Invocation['scope']['tenantId']
) {
	if (credential === undefined || credential === '')
		return yield* new DispatchError({
			code: 'unauthorized',
			message: 'Missing command credential'
		});
	const actor = yield* (yield* Identity.Service).authenticate(effectId, credential).pipe(
		Effect.catchIf(
			(error) => error instanceof Identity.AuthenticationError,
			(refused) =>
				Effect.flatMap(apiKeySubject(effectId, credential, tenantId), (subject) =>
					subject === undefined ? Effect.fail(refused) : Effect.succeed(subject)
				)
		)
	);
	if (actor.tenantId !== tenantId)
		return yield* new DispatchError({
			code: 'tenant_mismatch',
			message: 'Authenticated subject is outside the invocation tenant'
		});
	return actor;
});

const authenticateCommand = Effect.fn('Bolt.authenticateCommand')(function* <E>(
	invocation: Extract<Invocation, { _tag: 'Command' }>,
	binding: CommandBinding<E> | undefined,
	effectId: EffectId
) {
	if (binding?.origins.Command?.principal === 'public') {
		const claimed = mintedClaim(invocation.input);
		if (claimed !== undefined)
			return yield* new AccessControl.AccessDenied({
				action: 'authenticate',
				resource: invocation.command,
				reason: `a public command may not claim boundary-owned ${claimed}`
			});
		return {};
	}
	if (
		yield* SystemPrincipal.verifySystemSignature({
			headers: invocation.headers,
			command: invocation.command,
			tenantId: invocation.scope.tenantId,
			input: invocation.input,
			now: yield* Clock.currentTimeMillis
		})
	) {
		const system = SystemPrincipal.systemSubject(invocation.scope.tenantId);
		// Host-signed commands stamp identity from `invocation.scope`. A payload that also names
		// `tenantId` / `subject` is not a refusal — those keys are stripped before the case runs,
		// which is the same overwrite the session branch already pays. Refusing here made a signed
		// founder bootstrap fail when the payload restated a tenant the signature already bound.
		return { principal: system, actor: system };
	}
	const actor = yield* resolveSession(
		effectId,
		credentialFromHeaders(invocation.headers),
		invocation.scope.tenantId
	);
	const team = impersonatedTeamFromHeaders(invocation.headers);
	const principal =
		team === undefined ? actor : yield* (yield* AccessControl.Service).subjectAsTeam(actor, team);
	return {
		principal,
		actor,
		...(team === undefined ? {} : { impersonatedTeam: team })
	};
});

const authenticatePlugin = Effect.fn('Bolt.authenticatePlugin')(function* (
	invocation: Extract<Invocation, { _tag: 'Plugin' }>,
	effectId: EffectId
) {
	if (
		yield* SystemPrincipal.verifySystemSignature({
			headers: invocation.headers,
			command: invocation.command,
			tenantId: invocation.scope.tenantId,
			input: invocation.input,
			now: yield* Clock.currentTimeMillis
		})
	) {
		const system = SystemPrincipal.systemSubject(invocation.scope.tenantId);
		return { principal: system, actor: system };
	}
	const credential = credentialFromHeaders(invocation.headers);
	if (credential === undefined || credential === '') {
		if (invocation.plugin === 'data-browser')
			return yield* new AccessControl.AccessDenied({
				action: 'read',
				resource: pluginReadResource(
					invocation.input,
					`${invocation.plugin}/${invocation.command}`
				),
				reason:
					'a Plugin invocation must present a credential before its trustedContext is honoured'
			});
		return yield* new DispatchError({
			code: 'unauthorized',
			message: 'Missing command credential'
		});
	}
	const actor = yield* resolveSession(effectId, credential, invocation.scope.tenantId);
	const trustedContext = yield* Schema.decodeUnknownEffect(PluginTrustedContext)(
		invocation.trustedContext
	).pipe(Effect.mapError(invalidInput));
	if (trustedContext.impersonatedSubject === undefined)
		return { principal: actor, actor, trustedContext };
	const target = yield* (yield* Identity.Service).resolveSubject(
		effectId,
		'colony',
		trustedContext.impersonatedSubject
	);
	if (target.tenantId !== invocation.scope.tenantId)
		return yield* new DispatchError({
			code: 'tenant_mismatch',
			message: 'Plugin target is outside the invocation tenant'
		});
	return {
		principal: yield* (yield* AccessControl.Service).impersonate(actor, target),
		actor,
		trustedContext
	};
});

const invoke = Effect.fn('Bolt.invokeCommandBinding')(function* <E>(
	binding: CommandBinding<E>,
	context: ExecutionContext,
	rawInput: unknown
) {
	const rule = binding.origins[context.origin];
	if (rule === undefined)
		return yield* new AccessControl.AccessDenied({
			action: 'invoke',
			resource: binding.contract.name,
			reason: `${context.origin} is not an admitted origin for this command`
		});
	if (rule.principal === 'system' && context.principal?.system !== true)
		return yield* new AccessControl.AccessDenied({
			action: 'invoke',
			resource: binding.contract.name,
			reason: 'This command requires a per-invocation host proof'
		});
	const input = yield* decodeInput(binding, rawInput);
	if (rule.authorize !== undefined) yield* providedEffect(rule.authorize(context, input));
	return yield* providedEffect(binding.handle(context, input)).pipe(
		Effect.flatMap((response) => validateOutput(binding, response))
	);
});

/**
 * Every record an invocation writes carries its ids; each goes out as one JSON line and, when the
 * invocation ends, they are kept together in the `telemetry` collection — see `telemetry.ts`. A
 * failure the invocation ends with is one of those records, at error, before the result maps it;
 * a settled one records its time.
 */
export const dispatchInvocation = (invocation: Invocation) => {
	const sink = makeSink(invocation);
	const startedAt = Date.now();
	return dispatch(invocation).pipe(
		Effect.onExit((exit) => recordSettled(invocation, startedAt, exit)),
		Effect.ensuring(flushAll(sink)),
		Effect.annotateLogs(invocationAnnotations(invocation)),
		Effect.provideService(Sink, sink),
		Effect.provide(loggerFor(sink))
	);
};

const dispatch = Effect.fn('Bolt.dispatch')(function* (invocation: Invocation) {
	if (invocation._tag === 'Request') {
		if (new URL(invocation.url, 'http://bolt.invalid').pathname === '/health')
			return json({ status: 'ok' });
		const app = yield* answerAppRequest(invocation);
		if (app !== undefined) return app;
		const effectId = EffectId.make(invocation.id);
		const api = apiSegments(invocation.url);
		if (api !== undefined) {
			const caller = yield* resolveSession(
				effectId,
				credentialFromHeaders(invocation.headers),
				invocation.scope.tenantId
			);
			return yield* Effect.provideService(
				answerApiRequest(invocation, api, effectId, caller),
				Identity.CurrentSubject,
				caller
			);
		}
		const subject = yield* resolveSession(
			effectId,
			credentialFromHeaders(invocation.headers),
			invocation.scope.tenantId
		);
		return json({ subject, apps: (yield* AccessControl.Service).visibleApps(subject) });
	}
	if (invocation._tag === 'Realtime') {
		if (invocation.event._tag === 'Open')
			return { status: 200, headers: {}, realtime: { frames: [], nextCursor: '0' } };
		if (invocation.event._tag === 'Input') {
			const cursor = String(invocation.event.frame.sequence);
			return {
				status: 200,
				headers: {},
				realtime: {
					frames: [
						{ cursor, kind: invocation.event.frame.kind, bytes: invocation.event.frame.bytes }
					],
					nextCursor: cursor
				}
			};
		}
		if (invocation.event._tag === 'Pull')
			return { status: 200, headers: {}, realtime: { frames: [], nextCursor: '0' } };
		if (invocation.event._tag === 'Close' || invocation.event._tag === 'Cancel')
			return {
				status: 200,
				headers: {},
				realtime: {
					frames: [],
					close: {
						code: invocation.event._tag === 'Close' ? invocation.event.code : 1000,
						reason: invocation.event.reason
					}
				}
			};
		const exhausted: never = invocation.event;
		void exhausted;
		throw new Error('Unhandled realtime event');
	}
	const effectId = EffectId.make(invocation.id);
	if (invocation._tag === 'Plugin') {
		const claimed = mintedClaim(invocation.input);
		if (claimed !== undefined)
			return yield* mintedClaimDenied(
				'Plugin',
				`${invocation.plugin}/${invocation.command}`,
				claimed
			);
		const authority = yield* authenticatePlugin(invocation, effectId);
		const binding = yield* resolveCommand(invocation.command, 'Plugin', invocation.plugin);
		if (binding === undefined)
			return yield* new DispatchError({
				code: 'unknown_command',
				message: `Unknown plugin command: ${invocation.plugin}/${invocation.command}`
			});
		yield* (yield* RateLimits.Service).admit(
			commandBudgetKey(binding.contract),
			{
				tenantId: String(invocation.scope.tenantId),
				userId: authority.principal.userId
			},
			(yield* AccessControl.Service).limits(authority.principal)
		);
		return yield* invoke(
			binding,
			{
				effectId,
				tenantId: invocation.scope.tenantId,
				origin: 'Plugin',
				...authority
			},
			invocation.input
		);
	}
	if (invocation._tag === 'Task') {
		yield* assertCommandNamespace();
		const claimed = mintedClaim(invocation.input);
		if (claimed !== undefined) return yield* mintedClaimDenied('Task', invocation.command, claimed);
		const binding = yield* resolveCommand(invocation.command, 'Task');
		if (binding === undefined || binding.origins.Task === undefined)
			return yield* new AccessControl.AccessDenied({
				action: 'invoke',
				resource: invocation.command,
				reason: 'Task provenance does not authorize this route'
			});
		yield* (yield* RateLimits.Service).admit(
			commandBudgetKey(binding.contract),
			{ tenantId: String(invocation.scope.tenantId) },
			undefined
		);
		const run = invoke(
			binding,
			{
				effectId,
				tenantId: invocation.scope.tenantId,
				origin: 'Task',
				...(invocation.taskId === undefined
					? {}
					: { scheduledTask: { id: invocation.taskId, attempt: invocation.attempt } })
			},
			invocation.input
		);
		// The occurrence has no wall, so the run keeps its own claim alive for as long as it lasts.
		return yield* invocation.taskId === undefined
			? run
			: (yield* TaskQueue.Service).keepLeased(effectId, invocation.taskId, invocation.attempt, run);
	}
	if (invocation._tag !== 'Command')
		return yield* new DispatchError({
			code: 'unsupported_invocation',
			message: 'Unsupported command invocation'
		});
	yield* assertCommandNamespace();
	const binding = yield* resolveCommand(invocation.command, 'Command');
	const authority = yield* authenticateCommand(invocation, binding, effectId);
	if (binding === undefined)
		return yield* new DispatchError({
			code: 'unknown_command',
			message: `Unknown Bolt command: ${invocation.command}`
		});
	const context: ExecutionContext = {
		effectId,
		tenantId: invocation.scope.tenantId,
		origin: 'Command',
		...authority
	};
	const address = rateLimitAddress(invocation.input);
	yield* (yield* RateLimits.Service).admit(
		commandBudgetKey(binding.contract),
		{
			tenantId: String(invocation.scope.tenantId),
			userId: authority.principal?.userId,
			...(address === undefined ? {} : { address })
		},
		authority.principal === undefined
			? undefined
			: (yield* AccessControl.Service).limits(authority.principal)
	);
	const commandInput =
		authority.principal !== undefined
			? stripMintedIdentityFields(invocation.input)
			: invocation.input;
	const result = invoke(binding, context, commandInput);
	return yield* authority.principal === undefined
		? result
		: Effect.provideService(result, Identity.CurrentSubject, authority.principal);
});
