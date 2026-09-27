// API keys (X-18 identity): administrators read them; no grant, and never the secret's hash.
import { collection } from '../../../../decl/collection.ts';

export default collection('sys_api_key', { read: { fields: ['name', 'prefix', 'created_by', 'revoked_at', 'last_used_at', 'revision', 'created_at'] } });
