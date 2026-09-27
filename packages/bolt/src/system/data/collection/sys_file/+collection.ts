// Stored files (rule 18): grantable; a /files upload inserts the row. The storage key stays the engine's.
import { collection } from '../../../../decl/collection.ts';

export default collection('sys_file', { read: { fields: ['name', 'mime', 'size', 'sha256', 'field', 'revision', 'approval_id', 'created_at', 'created_by', 'updated_at', 'updated_by'] } });
