// Type corpus for the shell's view props (§3.2 role 5): an embedded renderer is handed a view without the record's row.
import type { CustomFieldView } from '../../src/shell/runtime.ts';
import type { CustomFieldView as KitView } from '../../../ui/src/kinds/context.ts';

export const shown: CustomFieldView = { mode: 'show', name: 'band', value: null };
export const edited: CustomFieldView = { mode: 'edit', name: 'band', value: null, disabled: false, onChange: () => {} };
export const kit: KitView = { mode: 'show', name: 'band', value: null };
// @ts-expect-error — a view still names its field
export const unnamed: CustomFieldView = { mode: 'show', value: null };
