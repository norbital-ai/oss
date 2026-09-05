<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Badge } from '#lib/badge';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import type { Editor, NodeViewRendererProps } from '@tiptap/core';
	import type { MentionItem } from './mention-item.js';

	let {
		editor,
		node,
		getPos,
		onDelete,
		metadataItems = []
	}: {
		editor: Editor;
		node: NodeViewRendererProps['node'];
		getPos: NodeViewRendererProps['getPos'];
		onDelete?: (id: string) => void;
		metadataItems?: MentionItem[];
	} = $props();

	const { t } = useI18n<UiKeys>();

	let id = $derived(node.attrs.id);

	// Resolve full metadata from metadataItems if we only have minimal data
	let mentionData = $derived.by((): MentionItem => {
		// If we have full data in attrs, use it
		if (node.attrs.label && node.attrs.icon) {
			return {
				id: node.attrs.id,
				type: node.attrs.itemType || 'collection',
				label: node.attrs.label,
				description: node.attrs.description,
				icon: node.attrs.icon,
				metadata: node.attrs.metadata
			};
		}

		// Otherwise, look up from metadataItems (for loaded content with minimal data)
		const resolved = metadataItems.find((item) => item.id === node.attrs.id);
		if (resolved) {
			return resolved;
		}

		// Fallback if not found
		return {
			id: node.attrs.id,
			type: node.attrs.itemType || 'collection',
			label: node.attrs.id,
			description: '',
			icon: 'lucide:circle',
			metadata: {}
		};
	});

	/**
	 * Formats a mention item into a human-readable label for display in badges
	 */
	function formatMentionItemLabel(item: MentionItem): string {
		const collectionName = item.metadata?.collectionName as string | undefined;

		switch (item.type) {
			case 'collection':
				// Check if this is a group (has groupType in metadata)
				if (item.metadata?.groupType) {
					// This is a group like "Model" or "Routes" - show with collection name
					return collectionName ? `${collectionName} > ${item.label}` : item.label;
				}
				// Regular collection - just show the name
				return item.label;

			case 'column':
				return collectionName ? `${collectionName} > ${item.label}` : item.label;

			case 'route':
				return collectionName ? `${collectionName} > ${item.metadata?.routeType}` : item.label;

			case 'template':
				// Templates have more context
				const templateType = item.metadata?.templateType;
				const routeType = item.metadata?.routeType;
				if (collectionName && templateType && routeType) {
					return `${collectionName} > ${routeType} > ${templateType} > ${item.label}`;
				}
				return item.label;

			default:
				return item.label;
		}
	}

	let icon = $derived(mentionData.icon);
	let displayLabel = $derived(formatMentionItemLabel(mentionData));

	// Handle removal when clicking X button
	function removeMentionTag() {
		// Call onDelete callback if it exists
		if (onDelete && id) {
			onDelete(id);
		}

		// Delete the node from the editor
		const pos = getPos();
		if (pos !== undefined) {
			editor.commands.deleteRange({ from: pos, to: pos + node.nodeSize });
		}
	}
</script>

<Badge class="gap-1 rounded-md" variant="outline">
	<Icon {icon} class="size-3.5 shrink-0 text-muted-foreground" />
	<span class="font-normal">{displayLabel}</span>
	<button
		onclick={removeMentionTag}
		class="ml-0.5 flex size-3.5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-secondary-foreground"
		title={t('common.remove')}
		type="button"
	>
		<Icon icon="lucide:x" class="size-3" />
	</button>
</Badge>
