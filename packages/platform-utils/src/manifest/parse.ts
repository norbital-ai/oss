import { z } from 'zod';
import { typeGuard } from '@norbital-ai/std/schema';
import type { NorbitalManifest } from './types.js';

const looseRecordSchema = z.record(z.string(), z.unknown());
const secretReferenceSchema = z.object({ type: z.literal('secret'), name: z.string().min(1) });
const connectionSchema = z.union([
	z.object({ type: z.literal('connection'), name: z.string().min(1) }),
	z.object({
		type: z.literal('http'),
		baseUrl: z.url(),
		authentication: z
			.union([
				z.object({ type: z.literal('bearer'), token: secretReferenceSchema }),
				z.object({
					type: z.literal('header'),
					header: z.string().min(1),
					value: secretReferenceSchema
				})
			])
			.optional()
	})
]);
const inboundBindingSchema = z.object({
	collection: z.string().min(1),
	pipeline: z.literal('import'),
	origin: z.discriminatedUnion('type', [
		z.object({
			type: z.literal('system-event'),
			event: z.string().min(1)
		}),
		z.object({
			type: z.literal('webhook'),
			events: z.array(z.string()).optional(),
			authentication: z
				.object({
					type: z.literal('hmac-sha256'),
					secret: secretReferenceSchema,
					signatureHeader: z.string().min(1).optional()
				})
				.optional(),
			eventId: z.object({ header: z.string().min(1) }).optional()
		}),
		z.object({
			type: z.literal('api-pull'),
			schedule: z.string().min(1),
			url: z.url(),
			method: z.enum(['GET', 'POST']).optional(),
			secretHeaders: z.record(z.string(), secretReferenceSchema).optional(),
			cursorQuery: z.string().optional(),
			nextCursorHeader: z.string().optional()
		})
	])
});
const destinationSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('system-event'),
		event: z.string().min(1)
	}),
	z.object({
		type: z.literal('api'),
		url: z.url(),
		method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']),
		headers: z.record(z.string(), z.string()).optional(),
		secretHeaders: z.record(z.string(), secretReferenceSchema).optional()
	}),
	z.object({
		type: z.literal('webhook'),
		url: z.union([z.url(), secretReferenceSchema]),
		authentication: z.object({ type: z.literal('bearer'), token: secretReferenceSchema }).optional()
	})
]);
const integrationDefinitionSchema = z.object({
	connection: connectionSchema.optional(),
	inbound: z.record(z.string(), inboundBindingSchema).optional(),
	outbound: z
		.record(
			z.string(),
			z.object({
				collection: z.string().min(1),
				pipeline: z.literal('export'),
				trigger: z.literal('collection-events'),
				destination: destinationSchema
			})
		)
		.optional(),
	identity: z.object({ externalEntity: z.string().min(1) }).optional(),
	conflicts: looseRecordSchema.optional(),
	reconciliation: z.object({ schedule: z.string().min(1) }).optional()
});

export const MANIFEST_VERSION = 1 as const;

const MANIFEST_APP_KEYS = [
	'name',
	'label',
	'description',
	'icon',
	'defaultChild',
	'thumbnail',
	'banner',
	'parent',
	'config'
] as const;

const MANIFEST_AUTOMATION_KEYS = [
	'name',
	'description',
	'enabled',
	'cron_schedule',
	'created_by_user_id',
	'config',
	'spec'
] as const;

const MANIFEST_AUTOMATION_SPEC_KEYS = [
	'kind',
	'task',
	'model',
	'systemPrompt',
	'tools',
	'agentProfileId'
] as const;

function assertOnlyKnownKeys(
	obj: Record<string, unknown>,
	allowed: readonly string[],
	entryPath: string
): void {
	for (const key of Object.keys(obj)) {
		if (!allowed.includes(key)) {
			throw new Error(`NorbitalManifest: ${entryPath}: unknown key "${key}"`);
		}
	}
}

function validateManifestApp(key: string, raw: unknown): void {
	if (!typeGuard(looseRecordSchema, raw)) {
		throw new Error(`NorbitalManifest: apps.${key}: expected object`);
	}
	const entry = raw;
	const entryPath = `apps.${key}`;
	assertOnlyKnownKeys(entry, MANIFEST_APP_KEYS, entryPath);
}

function validateManifestAutomationSpec(raw: unknown, entryPath: string): void {
	if (raw === undefined) return;
	if (!typeGuard(looseRecordSchema, raw)) {
		throw new Error(`NorbitalManifest: ${entryPath}.spec: expected object`);
	}
	const spec = raw;
	assertOnlyKnownKeys(spec, MANIFEST_AUTOMATION_SPEC_KEYS, `${entryPath}.spec`);
	if (spec.kind !== 'agent') {
		throw new Error(`NorbitalManifest: ${entryPath}.spec.kind: expected "agent"`);
	}
	if (typeof spec.task !== 'string' || spec.task.length === 0) {
		throw new Error(`NorbitalManifest: ${entryPath}.spec.task: must be a non-empty string`);
	}
}

function validateManifestAutomation(key: string, raw: unknown): void {
	if (!typeGuard(looseRecordSchema, raw)) {
		throw new Error(`NorbitalManifest: automations.${key}: expected object`);
	}
	const entry = raw;
	const entryPath = `automations.${key}`;
	assertOnlyKnownKeys(entry, MANIFEST_AUTOMATION_KEYS, entryPath);
	validateManifestAutomationSpec(entry.spec, entryPath);
}

export function parseNorbitalManifest(input: unknown): NorbitalManifest {
	if (!typeGuard(looseRecordSchema, input)) {
		throw new Error('NorbitalManifest: expected object');
	}
	const manifest = input as NorbitalManifest;
	if (manifest.version !== MANIFEST_VERSION) {
		throw new Error(
			`NorbitalManifest: unsupported version ${String((manifest as { version?: unknown }).version)}`
		);
	}
	if (!typeGuard(looseRecordSchema, manifest.collections)) {
		throw new Error('NorbitalManifest: missing collections');
	}
	if (manifest.apps) {
		if (!typeGuard(looseRecordSchema, manifest.apps)) {
			throw new Error('NorbitalManifest: apps must be an object');
		}
		for (const [key, raw] of Object.entries(manifest.apps)) {
			validateManifestApp(key, raw);
		}
	}
	if (manifest.automations) {
		if (!typeGuard(looseRecordSchema, manifest.automations)) {
			throw new Error('NorbitalManifest: automations must be an object');
		}
		for (const [key, raw] of Object.entries(manifest.automations)) {
			validateManifestAutomation(key, raw);
		}
	}
	if (manifest.secrets) {
		if (!typeGuard(looseRecordSchema, manifest.secrets)) {
			throw new Error('NorbitalManifest: secrets must be an object');
		}
		for (const [key, raw] of Object.entries(manifest.secrets)) {
			if (!typeGuard(looseRecordSchema, raw)) {
				throw new Error(`NorbitalManifest: secrets.${key}: expected object`);
			}
			if (typeof raw.description !== 'string' || typeof raw.required !== 'boolean') {
				throw new Error(
					`NorbitalManifest: secrets.${key}: description must be a string and required must be a boolean`
				);
			}
		}
	}
	if (manifest.integrations) {
		if (!typeGuard(looseRecordSchema, manifest.integrations)) {
			throw new Error('NorbitalManifest: integrations must be an object');
		}
		for (const [key, raw] of Object.entries(manifest.integrations)) {
			if (!typeGuard(looseRecordSchema, raw) || raw.name !== key) {
				throw new Error(`NorbitalManifest: integrations.${key}: name must match its key`);
			}
			if (!typeGuard(looseRecordSchema, raw.definition)) {
				throw new Error(`NorbitalManifest: integrations.${key}.definition: expected object`);
			}
			const parsed = integrationDefinitionSchema.safeParse(raw.definition);
			if (!parsed.success) {
				throw new Error(
					`NorbitalManifest: integrations.${key}.definition: ${parsed.error.message}`
				);
			}
		}
	}
	return manifest;
}
