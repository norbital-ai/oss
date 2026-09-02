import { Clock, Effect, Result, Schema } from 'effect';
import {
	EffectId,
	PluginTrustedContext,
	type DispatchResponse,
	type Invocation
} from '@norbital-ai/bolt-protocol';
import * as AccessControl from '#lib/runtime/access/access-control.js';
import * as SystemPrincipal from '#lib/runtime/access/system-principal.js';
import * as Identity from '#lib/runtime/identity/identity.js';
import * as RateLimits from '#lib/runtime/rate-limits.js';
import { DispatchError } from '#lib/runtime/workspace.js';
import { decodeUnknownSchema } from '#lib/schema-decode.js';
import {
	assertCommandNamespace,
	resolveCompositeCommand,
	resolveFixedCommand,
	resolveWorkspaceCommand,
	type CommandBinding,
	type ExecutionContext,
	type InvocationOrigin
} from './commands.js';

export { DispatchError } from '#lib/runtime/workspace.js';
export { collectionQuery } from './commands.js';

const JsonObject = Schema.Record(Schema.String, Schema.Json);
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
	if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
	const address = Reflect.get(payload, 'address');
	const email = Reflect.get(payload, 'email');
	const value = typeof address === 'string' ? address : typeof email === 'string' ? email : undefined;
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
	return typeof collection === 'string' && collection.length > 0 ? collection : fallback;
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

const commandBudgetKey = (contract: { readonly name: string }): string =>
	'budgetKey' in contract && typeof contract.budgetKey === 'string'
		? contract.budgetKey
		: contract.name;

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
	const declared = binding.contract.responses.find((candidate) => candidate.status === response.status);
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

const resolveCommand = Effect.fn('Bolt.resolveCommand')(function* (
	name: string,
	origin: Exclude<InvocationOrigin, 'Plugin'>
) {
	const fixed = resolveFixedCommand(name);
	if (fixed !== undefined) return fixed;
	return yield* resolveWorkspaceCommand(name, origin);
});

const resolveSession = Effect.fn('Bolt.resolveSession')(function* (
	effectId: EffectId,
	credential: string | undefined,
	tenantId: Invocation['scope']['tenantId']
) {
	if (credential === undefined || credential === '')
		return yield* new DispatchError({ code: 'unauthorized', message: 'Missing command credential' });
	const actor = yield* (yield* Identity.Service).authenticate(effectId, credential);
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
		const claimed = mintedClaim(invocation.input);
		if (claimed !== undefined)
			return yield* new AccessControl.AccessDenied({
				action: 'authenticate',
				resource: invocation.command,
				reason: `a command may not claim boundary-owned ${claimed}`
			});
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

export const dispatchInvocation = Effect.fn('Bolt.dispatch')(function* (invocation: Invocation) {
	if (invocation._tag === 'Request') {
		if (new URL(invocation.url, 'http://bolt.invalid').pathname === '/health')
			return json({ status: 'ok' });
		const effectId = EffectId.make(invocation.id);
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
					frames: [{ cursor, kind: invocation.event.frame.kind, bytes: invocation.event.frame.bytes }],
					nextCursor: cursor
				}
			};
		}
		return {
			status: 200,
			headers: {},
			realtime: {
				frames: [],
				...(invocation.event._tag === 'Close' || invocation.event._tag === 'Cancel'
					? { close: {
						code: invocation.event._tag === 'Close' ? invocation.event.code : 1000,
						reason: invocation.event.reason
					} }
					: {})
			}
		};
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
		const binding = resolveCompositeCommand(invocation.plugin, invocation.command);
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
		return yield* invoke(binding, {
			effectId,
			tenantId: invocation.scope.tenantId,
			origin: 'Plugin',
			...authority
		}, invocation.input);
	}
	if (invocation._tag === 'Task') {
		yield* assertCommandNamespace();
		const claimed = mintedClaim(invocation.input);
		if (claimed !== undefined)
			return yield* mintedClaimDenied('Task', invocation.command, claimed);
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
		return yield* invoke(binding, {
			effectId,
			tenantId: invocation.scope.tenantId,
			origin: 'Task'
		}, invocation.input);
	}
	if (invocation._tag !== 'Command')
		return yield* new DispatchError({
			code: 'unsupported_invocation',
			message: 'Unsupported command invocation'
		});
	yield* assertCommandNamespace();
	const fixed = resolveFixedCommand(invocation.command);
	const authority = yield* authenticateCommand(invocation, fixed, effectId);
	const binding = fixed ?? (yield* resolveWorkspaceCommand(invocation.command, 'Command'));
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
		authority.principal !== undefined && authority.principal.system !== true
			? stripMintedIdentityFields(invocation.input)
			: invocation.input;
	const result = invoke(binding, context, commandInput);
	return yield* authority.principal === undefined
		? result
		: Effect.provideService(result, Identity.CurrentSubject, authority.principal);
});
