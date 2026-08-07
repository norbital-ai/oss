import type {
	TenantDbProvider,
	NeonBranchConfig,
	BranchOptions,
	RestorePointTimestamp,
	RestorePointLsn
} from './provider.js';
import { Client } from '@neondatabase/serverless';
import { delay } from '@norbital-ai/std/async';

interface NeonProjectResponse {
	project: { id: string; pg_version?: number };
	branch: {
		id: string;
		name: string;
		project_id: string;
		parent_id: string | null;
		current_state: string;
	};
	connection_uris: Array<{ connection_uri: string }>;
	endpoints: Array<{ id: string; host: string; current_state: string }>;
	operations?: NeonOperation[];
}

interface NeonGetProjectResponse {
	project: { id: string; pg_version?: number };
}

interface NeonBranchResponse {
	branch: {
		id: string;
		name: string;
		project_id: string;
		parent_id: string | null;
		current_state: string;
	};
	endpoints: Array<{ id: string; host: string; current_state: string }>;
	connection_uris: Array<{ connection_uri: string }>;
	operations?: NeonOperation[];
}

interface NeonListBranchesResponse {
	branches: Array<{
		id: string;
		name: string;
		project_id: string;
		parent_id: string | null;
		current_state: string;
		created_at: string;
	}>;
	pagination?: { cursor: string | null; has_more?: boolean };
}

interface NeonListProjectsResponse {
	projects: Array<{ id: string; name: string; created_at: string }>;
	pagination?: { cursor: string | null; has_more?: boolean };
}

export type NeonProjectSummary = { id: string; name: string; createdAt: string };

interface NeonOperation {
	id: string;
	status: string;
	action?: string;
}

interface NeonRestoreBranchResponse {
	operations?: NeonOperation[];
}

interface NeonCreateBranchRequest {
	branch: {
		parent_id: string;
		name?: string;
		expires_at?: string;
	};
	endpoints: Array<{ type: 'read_write' }>;
}

function normalizeNeonConnectionUri(uri: string): string {
	const url = new URL(uri);
	const sslMode = url.searchParams.get('sslmode');
	if (sslMode === 'prefer' || sslMode === 'require' || sslMode === 'verify-ca') {
		url.searchParams.set('sslmode', 'verify-full');
	}
	return url.toString();
}

function firstConnectionUri(response: {
	connection_uris?: Array<{ connection_uri: string }>;
}): string {
	const uri = response.connection_uris?.[0]?.connection_uri;
	if (!uri) throw new Error('Neon API response missing connection_uris');
	return normalizeNeonConnectionUri(uri);
}

/** Fallback poll when create response is not yet ready — keep short; connect probe is the real gate. */
const BRANCH_READY_FALLBACK_TIMEOUT_MS = 15_000;
const CONNECT_PROBE_TIMEOUT_MS = 15_000;

function branchIsReady(branch: { current_state: string }): boolean {
	return branch.current_state === 'ready';
}

function branchResponseIsReady(res: NeonBranchResponse): boolean {
	if (branchIsReady(res.branch)) return true;
	const endpoints = res.endpoints ?? [];
	return (
		endpoints.length > 0 &&
		endpoints.every(
			(endpoint) => endpoint.current_state === 'ready' || endpoint.current_state === 'active'
		)
	);
}

function parseConnectionStringHints(connectionString: string): {
	databaseName: string;
	roleName: string;
} {
	const url = new URL(connectionString);
	return {
		databaseName: url.pathname.replace(/^\//, '') || 'neondb',
		roleName: decodeURIComponent(url.username)
	};
}

export class NeonTenantDbProvider implements TenantDbProvider {
	private apiKey: string;
	private baseUrl = 'https://console.neon.tech/api/v2';
	private regionId = 'aws-ap-southeast-1';
	private historyRetentionSeconds = 21600; // 6 hours (Neon free tier max)
	private pgVersion = 18;

	constructor(apiKey: string) {
		this.apiKey = apiKey;
	}

	private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
		const url = `${this.baseUrl}${path}`;
		const method = (init.method ?? 'GET').toUpperCase();
		const retryable = method === 'GET' || method === 'POST';

		const maxAttempts = 4;
		let lastError: Error | null = null;
		// stupidity:allow A6 -- retries must wait for the previous response and backoff
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			const res = await fetch(url, {
				...init,
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
					'Content-Type': 'application/json',
					Accept: 'application/json',
					...init.headers
				}
			});

			if (res.ok) {
				return res.json() as Promise<T>;
			}

			const body = await res.text().catch(() => '');
			const error = new Error(`Neon API ${method} ${path} failed (${res.status}): ${body}`);
			lastError = error;

			const isRateLimit = res.status === 429;
			const isServerError = res.status >= 500 && res.status < 600;
			const canRetry = retryable && (isRateLimit || isServerError);

			if (!canRetry) {
				throw error;
			}

			if (attempt < maxAttempts - 1) {
				let delayMs = 2 ** attempt * 1000;
				if (isRateLimit) {
					const retryAfter = res.headers.get('Retry-After');
					if (retryAfter) {
						const parsed = Number(retryAfter);
						if (!Number.isNaN(parsed) && parsed > 0) {
							delayMs = parsed * 1000;
						}
					}
				}
				const jitter = Math.floor(Math.random() * 250);
				await delay(delayMs + jitter);
			}
		}
		throw lastError ?? new Error(`Neon API ${method} ${path} failed after retries`);
	}

	async createOrgProject(
		_orgId: string,
		orgName: string
	): Promise<{ projectId: string; mainBranch: NeonBranchConfig }> {
		const createRes = await this.request<NeonProjectResponse>('/projects', {
			method: 'POST',
			body: JSON.stringify({
				project: {
					name: orgName,
					region_id: this.regionId,
					pg_version: this.pgVersion,
					provisioner: 'k8s-neonvm',
					history_retention_seconds: this.historyRetentionSeconds,
					branch: { name: 'main' }
				}
			})
		});

		const projectId = createRes.project.id;
		const branchId = createRes.branch.id;

		try {
			if (!createRes.endpoints?.[0]) {
				throw new Error('Neon project created without endpoint');
			}

			const connectionString = firstConnectionUri(createRes);

			if (createRes.project.pg_version != null && createRes.project.pg_version !== this.pgVersion) {
				throw new Error(
					`Neon project ${projectId} must be PostgreSQL ${this.pgVersion}; got ${createRes.project.pg_version}`
				);
			}

			await this.awaitBranchUsable({
				projectId,
				branchId,
				initial: createRes,
				connectionString
			});

			if (createRes.project.pg_version == null) {
				await this.assertProjectPgVersion(projectId);
			}

			return {
				projectId,
				mainBranch: { projectId, branchId, connectionString }
			};
		} catch (error) {
			await this.deleteOrgProject(projectId).catch(() => {
				// best-effort — avoid orphaned projects when provisioning fails
			});
			throw error;
		}
	}

	async deleteOrgProject(projectId: string): Promise<void> {
		await this.request(`/projects/${projectId}`, { method: 'DELETE' });
	}

	async createBranch(
		projectId: string,
		parentBranchId: string,
		options?: BranchOptions
	): Promise<NeonBranchConfig> {
		const body: NeonCreateBranchRequest = {
			branch: { parent_id: parentBranchId },
			endpoints: [{ type: 'read_write' }]
		};
		if (options?.name) {
			body.branch.name = options.name;
		}
		if (options?.expiresAt) {
			body.branch.expires_at = options.expiresAt.toISOString();
		}

		const res = await this.request<NeonBranchResponse>(`/projects/${projectId}/branches`, {
			method: 'POST',
			body: JSON.stringify(body)
		});

		const branchId = res.branch.id;
		const connectionString = firstConnectionUri(res);

		await this.awaitBranchUsable({
			projectId,
			branchId,
			initial: res,
			connectionString
		});

		if (!res.endpoints?.[0]) {
			throw new Error('Neon branch created without endpoint');
		}

		return { projectId, branchId, connectionString };
	}

	async deleteBranch(projectId: string, branchId: string): Promise<void> {
		await this.request(`/projects/${projectId}/branches/${branchId}`, { method: 'DELETE' });
	}

	async resetBranchFromParent(projectId: string, branchId: string): Promise<void> {
		const listRes = await this.request<NeonListBranchesResponse>(`/projects/${projectId}/branches`);
		const branch = listRes.branches.find((b) => b.id === branchId);
		if (!branch?.parent_id) {
			throw new Error(`Branch ${branchId} has no parent to reset from`);
		}

		await this.request(`/projects/${projectId}/branches/${branchId}/restore`, {
			method: 'POST',
			body: JSON.stringify({ source_branch_id: branch.parent_id })
		});
	}

	async restoreBranch(
		projectId: string,
		branchId: string,
		point: RestorePointTimestamp | RestorePointLsn,
		preserveName?: string
	): Promise<{ backupBranchId: string }> {
		const backupName = preserveName ?? `backup_${Date.now()}`;
		const body: Record<string, unknown> = {
			source_branch_id: branchId,
			preserve_under_name: backupName
		};
		if ('timestamp' in point) {
			body.source_timestamp = point.timestamp;
		} else {
			body.source_lsn = point.lsn;
		}

		const res = await this.request<NeonRestoreBranchResponse>(
			`/projects/${projectId}/branches/${branchId}/restore`,
			{
				method: 'POST',
				body: JSON.stringify(body)
			}
		);

		await this.waitForOperations(projectId, res.operations ?? []);
		await this.waitForBranch(projectId, branchId, BRANCH_READY_FALLBACK_TIMEOUT_MS);

		return { backupBranchId: backupName };
	}

	async provisionOrgZones(
		orgId: string,
		orgName: string
	): Promise<{
		projectId: string;
		live: NeonBranchConfig;
	}> {
		const { projectId, mainBranch: live } = await this.createOrgProject(orgId, orgName);
		return { projectId, live };
	}

	async ensureDevBranch(
		projectId: string,
		previewBranchId: string,
		containerId: string
	): Promise<NeonBranchConfig> {
		const branchName = `dev:${containerId}`;

		const listRes = await this.request<NeonListBranchesResponse>(`/projects/${projectId}/branches`);
		const existing = listRes.branches.find((b) => b.name === branchName);
		if (existing) {
			const connectionString = await this.getBranchConnectionString(projectId, existing.id);
			return { projectId, branchId: existing.id, connectionString };
		}

		return this.createBranch(projectId, previewBranchId, { name: branchName });
	}

	async listProjectsByName(name: string): Promise<NeonProjectSummary[]> {
		const all: NeonProjectSummary[] = [];
		let cursor: string | null = null;
		// stupidity:allow A6 -- each page supplies the cursor for the next request
		for (;;) {
			const query = new URLSearchParams({ limit: '400', search: name });
			if (cursor) query.set('cursor', cursor);
			const page = await this.request<NeonListProjectsResponse>(`/projects?${query}`);
			all.push(
				...page.projects.map((project) => ({
					id: project.id,
					name: project.name,
					createdAt: project.created_at
				}))
			);
			if (!page.pagination?.has_more) break;
			cursor = page.pagination.cursor ?? null;
			if (!cursor) break;
		}
		return all.filter((project) => project.name === name);
	}

	/** List all projects accessible by the API key. */
	async listAllProjects(): Promise<NeonProjectSummary[]> {
		const all: NeonProjectSummary[] = [];
		let cursor: string | null = null;
		// stupidity:allow A6 -- each page supplies the cursor for the next request
		for (;;) {
			const query = new URLSearchParams({ limit: '400' });
			if (cursor) query.set('cursor', cursor);
			const page = await this.request<NeonListProjectsResponse>(`/projects?${query}`);
			all.push(
				...page.projects.map((project) => ({
					id: project.id,
					name: project.name,
					createdAt: project.created_at
				}))
			);
			if (!page.pagination?.has_more) break;
			cursor = page.pagination.cursor ?? null;
			if (!cursor) break;
		}
		return all;
	}

	async getProject(projectId: string): Promise<{ id: string; name: string }> {
		const response = await this.request<{ project: { id: string; name: string } }>(
			`/projects/${projectId}`
		);
		return response.project;
	}

	async resolveExistingOrgProject(
		orgName: string
	): Promise<{ projectId: string; mainBranch: NeonBranchConfig } | null> {
		const projects = await this.listProjectsByName(orgName);
		if (projects.length === 0) return null;

		const projectId = projects[projects.length - 1].id;
		const listed = await this.listBranches(projectId);
		const main =
			listed.branches.find((branch) => branch.name === 'main') ??
			listed.branches.find((branch) => branch.parent_id == null);
		if (!main) {
			throw new Error(`Neon project ${projectId} (${orgName}) has no main branch`);
		}

		const connectionString = await this.getBranchConnectionString(projectId, main.id);

		return {
			projectId,
			mainBranch: { projectId, branchId: main.id, connectionString }
		};
	}

	async getBranchConnectionString(
		projectId: string,
		branchId: string,
		opts?: { referenceConnectionString?: string }
	): Promise<string> {
		const res = await this.request<NeonBranchResponse>(
			`/projects/${projectId}/branches/${branchId}`
		);
		const direct = res.connection_uris?.[0]?.connection_uri;
		if (direct) return normalizeNeonConnectionUri(direct);

		const hints = opts?.referenceConnectionString
			? parseConnectionStringHints(opts.referenceConnectionString)
			: { databaseName: 'neondb', roleName: 'neondb_owner' };
		const query = new URLSearchParams({
			branch_id: branchId,
			database_name: hints.databaseName,
			role_name: hints.roleName,
			pooled: 'true'
		});
		const uriRes = await this.request<{ connection_uri?: string; uri?: string }>(
			`/projects/${projectId}/connection_uri?${query}`
		);
		const connectionUri = uriRes.connection_uri ?? uriRes.uri;
		if (!connectionUri) {
			throw new Error('Neon connection_uri response missing connection URI');
		}
		return normalizeNeonConnectionUri(connectionUri);
	}

	async listBranches(projectId: string): Promise<NeonListBranchesResponse> {
		const all: NeonListBranchesResponse['branches'] = [];
		let cursor: string | null = null;
		// stupidity:allow A6 -- each page supplies the cursor for the next request
		for (;;) {
			const query: string = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
			const page: NeonListBranchesResponse = await this.request<NeonListBranchesResponse>(
				`/projects/${projectId}/branches${query}`
			);
			all.push(...page.branches);
			if (!page.pagination?.has_more) break;
			cursor = page.pagination.cursor ?? null;
			if (!cursor) break;
		}
		return { branches: all };
	}

	private async assertProjectPgVersion(projectId: string): Promise<void> {
		const res = await this.request<NeonGetProjectResponse>(`/projects/${projectId}`);
		if (res.project.pg_version !== this.pgVersion) {
			throw new Error(
				`Neon project ${projectId} must be PostgreSQL ${this.pgVersion}; got ${res.project.pg_version ?? 'unknown'}`
			);
		}
	}

	private async assertConnectable(
		connectionString: string,
		timeoutMs = CONNECT_PROBE_TIMEOUT_MS
	): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		let lastError: unknown = null;
		// stupidity:allow A6 -- connection probes are ordered retries with a delay
		while (Date.now() < deadline) {
			const client = new Client({ connectionString });
			client.on('error', (error) => {
				// A dropped connection rejects the pending query (caught below) and fires 'error';
				// without a listener the latter kills the process on a probe.
				console.warn('[neon-provider] connect probe connection dropped', error);
			});
			try {
				await client.connect();
				await client.query('SELECT 1');
				return;
			} catch (error) {
				lastError = error;
				await delay(250);
			} finally {
				await client.end().catch(() => {
					// probe — ignore
				});
			}
		}
		const message = lastError instanceof Error ? lastError.message : String(lastError);
		throw new Error(`Neon branch not connectable within ${timeoutMs}ms: ${message}`);
	}

	private async awaitBranchUsable(input: {
		projectId: string;
		branchId: string;
		initial: NeonBranchResponse;
		connectionString: string;
	}): Promise<void> {
		if (branchResponseIsReady(input.initial)) {
			try {
				await this.assertConnectable(input.connectionString);
				return;
			} catch {
				// stupidity:ignore -- a failed connect probe deliberately falls through to polling
				// fall through to operation/branch polling
			}
		}

		const operations = input.initial.operations ?? [];
		if (operations.length > 0) {
			await this.waitForOperations(input.projectId, operations, 30_000);
		}

		if (!branchResponseIsReady(input.initial)) {
			await this.waitForBranch(input.projectId, input.branchId, BRANCH_READY_FALLBACK_TIMEOUT_MS);
		}

		await this.assertConnectable(input.connectionString);
	}

	private async waitForOperations(
		projectId: string,
		operations: NeonOperation[],
		timeoutMs = 120_000
	): Promise<void> {
		if (operations.length === 0) return;
		const deadline = Date.now() + timeoutMs;
		const pending = new Map(operations.map((operation) => [operation.id, operation]));
		// stupidity:allow A6 -- polling rounds wait between Neon operation status checks
		while (pending.size > 0) {
			if (Date.now() > deadline) {
				const stuck = [...pending.values()].map(
					(operation) => `${operation.id}${operation.action ? ` (${operation.action})` : ''}`
				);
				throw new Error(
					`Neon operations did not finish within ${timeoutMs}ms: ${stuck.join(', ')}`
				);
			}
			// stupidity:allow A6 -- sequential checks avoid an API burst and fail fast deterministically
			for (const [operationId, known] of [...pending.entries()]) {
				const res = await this.request<{ operation: NeonOperation }>(
					`/projects/${projectId}/operations/${operationId}`
				);
				const operation = res.operation;
				const status = operation.status;
				if (status === 'finished' || status === 'skipped' || status === 'cancelled') {
					pending.delete(operationId);
				} else if (status === 'failed' || status === 'error') {
					const action = operation.action ?? known.action ?? 'unknown';
					throw new Error(`Neon operation ${operationId} (${action}) failed with status ${status}`);
				}
			}
			if (pending.size > 0) {
				await delay(500);
			}
		}
	}

	private async waitForBranch(
		projectId: string,
		branchId: string,
		timeoutMs = BRANCH_READY_FALLBACK_TIMEOUT_MS
	): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		let lastState = 'unknown';
		let lastEndpointStates: string[] = [];
		// stupidity:allow A6 -- branch readiness polling is intentionally sequential
		while (Date.now() < deadline) {
			const res = await this.request<NeonBranchResponse>(
				`/projects/${projectId}/branches/${branchId}`
			);
			lastState = res.branch.current_state;
			lastEndpointStates = (res.endpoints ?? []).map((endpoint) => endpoint.current_state);
			if (branchResponseIsReady(res)) return;

			await delay(500);
		}
		const endpointSummary =
			lastEndpointStates.length > 0 ? `, endpoints=[${lastEndpointStates.join(', ')}]` : '';
		throw new Error(
			`Branch ${branchId} still not ready after operations finished (last state=${lastState}${endpointSummary})`
		);
	}
}
