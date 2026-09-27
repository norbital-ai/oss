// Secrets (§5.11.4): AES-256-GCM envelopes in the tenant's `sys_config`, bound to (owner, name). Every host binds the
// same store (`bolt start` and any other host); the host supplies only the 32-byte key.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { TenantDb } from './contracts.ts';

export type Secrets = {
	status(owner: string): Promise<{ readonly [name: string]: boolean }>;
	set(owner: string, name: string, value: string): Promise<void>;
	clear(owner: string, name: string): Promise<void>;
	/** Host-only (connection auth, webhook secrets): never reaches a route, the guest or a log. */
	use(owner: string, name: string): Promise<string | null>;
	/** Workspace values by env name, as the runs area reads them synchronously (webhook secrets). */
	env(name: string): string | undefined;
	load(): Promise<void>;
};
const prefix = (owner: string) => `secret:${owner}:`;
export function sealedSecrets(db: TenantDb, key: Buffer | null, declared: { readonly [name: string]: { secret?: boolean; default?: string } }): Secrets {
	const aad = (owner: string, name: string) => Buffer.from(`bolt\u0000${owner}\u0000${name}`);
	const seal = (owner: string, name: string, value: string): string => {
		const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key!, iv).setAAD(aad(owner, name));
		const ct = Buffer.concat([c.update(value, 'utf8'), c.final()]);
		return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
	};
	const open = (owner: string, name: string, sealed: string): string | null => {
		if (key === null) return null;
		try {
			const b = Buffer.from(sealed, 'base64'), d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)).setAAD(aad(owner, name));
			d.setAuthTag(b.subarray(12, 28));
			return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
		} catch { return null; } // a copied envelope fails on another owner (L-BOLT-312)
	};
	const workspace = new Map<string, string>();
	const s: Secrets = {
		async status(owner) {
			const [r] = await db.read([{ text: `SELECT key FROM sys_config WHERE key LIKE $1`, params: [`${prefix(owner)}%`] }]);
			const set = new Set(r!.rows.map((x) => String(x['key']).slice(prefix(owner).length)));
			const names = owner === 'workspace' ? Object.keys(declared) : [...set];
			return Object.fromEntries(names.map((n) => [n, set.has(n)]));
		},
		async set(owner, name, value) {
			if (key === null) throw new Error('this host has no BOLT_MASTER_KEY; secrets cannot be stored');
			// `oauth:<connection>` is the host's own token entry (oauth.ts), never an env value
			const token = name.startsWith('oauth:');
			if (owner === 'workspace' && !token && declared[name] === undefined) throw new Error(`'${name}' is not a declared env name`);
			await db.write({ text: `INSERT INTO sys_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
				params: [prefix(owner) + name, seal(owner, name, value)] });
			if (owner === 'workspace' && !token) workspace.set(name, value);
		},
		async clear(owner, name) {
			await db.write({ text: `DELETE FROM sys_config WHERE key = $1`, params: [prefix(owner) + name] });
			if (owner === 'workspace') workspace.delete(name);
		},
		async use(owner, name) {
			const [r] = await db.read([{ text: `SELECT value FROM sys_config WHERE key = $1`, params: [prefix(owner) + name] }]);
			const v = r!.rows[0]?.['value'];
			return typeof v === 'string' ? open(owner, name, v) : null;
		},
		env: (name) => workspace.get(name) ?? declared[name]?.default,
		async load() {
			const [r] = await db.read([{ text: `SELECT key, value FROM sys_config WHERE key LIKE $1`, params: [`${prefix('workspace')}%`] }]);
			workspace.clear();
			for (const row of r!.rows) {
				const name = String(row['key']).slice(prefix('workspace').length), v = open('workspace', name, String(row['value']));
				if (v !== null && !name.startsWith('oauth:')) workspace.set(name, v);
			}
		},
	};
	return s;
}
