export type { TKanbanItem, TCardSnippet, KanbanProps, KanbanColumnProps } from './types.js';

// Component imports - adjust paths to match your actual file names
import KanbanColumnComponent from './kanban-column.svelte';
import KanbanProviderComponent from './kanban.svelte';

// Named exports
export { KanbanColumnComponent as Column, KanbanProviderComponent as Provider };

// Default export with explicit type (fixes TypeScript portability warning)
const Kanban = {
	Column: KanbanColumnComponent,
	Provider: KanbanProviderComponent
} as const;

export default Kanban;
