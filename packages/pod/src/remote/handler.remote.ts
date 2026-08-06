import type { HandlerDefinition } from '$lib/authoring/automations/handlers.js';
import { beforeApiStorage } from '$lib/server/collection/hook-api-context.server.js';
import { error } from '$lib/server/http.js';
import { requestI18n } from '$lib/server/i18n.js';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';
import { getTenantWorkspace } from '$lib/server/bootstrap/tenant_workspace.server.js';

const invokeSchema = z.object({ name: z.string(), payload: z.unknown() });

/** The kind word an unknown-handler refusal names, translated per locale. */
function kindLabel(kind: string | undefined): string {
	const i18n = requestI18n();
	if (kind === 'command') return i18n.t('pod.server.command');
	if (kind === 'query') return i18n.t('pod.server.query');
	return i18n.t('pod.server.handler');
}

async function validatePayload(schema: StandardSchemaV1, payload: unknown): Promise<unknown> {
	const result = schema['~standard'].validate(payload);
	const resolved = await Promise.resolve(result);
	if (resolved.issues?.length) {
		throw error(400, resolved.issues[0]?.message ?? requestI18n().t('pod.server.invalidPayload'));
	}
	if (!('value' in resolved)) {
		throw error(400, requestI18n().t('pod.server.invalidPayload'));
	}
	return resolved.value;
}

async function runHandler(
	name: string,
	payload: unknown,
	expectedKind?: HandlerDefinition['kind']
): Promise<unknown> {
	const def = getTenantWorkspace().registered.remotes[name];
	if (!def || (expectedKind && def.kind !== expectedKind)) {
		throw error(
			400,
			requestI18n().t('pod.server.unknownHandler', {
				kind: kindLabel(expectedKind),
				name
			})
		);
	}
	const validated = await validatePayload(def.schema, payload);
	const api = beforeApiStorage.getStore();
	if (!api) throw error(500, 'HandlerApi not available');
	return def.handler(validated, api);
}

export const invokeCommand = async (input: unknown) => {
	const { name, payload } = invokeSchema.parse(input);
	return runHandler(name, payload, 'command');
};

export const invokeQuery = async (input: unknown) => {
	const { name, payload } = invokeSchema.parse(input);
	return runHandler(name, payload, 'query');
};

export const invokeHandler = async (input: unknown) => {
	const { name, payload } = invokeSchema.parse(input);
	return runHandler(name, payload);
};
