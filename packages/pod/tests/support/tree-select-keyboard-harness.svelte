<script lang="ts">
	import { TreeSelect, type BaseTreeItem } from '@norbital-ai/ui/tree-select';

	const items: readonly BaseTreeItem<Record<string, never>>[] = [
		{
			id: 'root',
			title: 'Conversations',
			icon: 'lucide:messages-square',
			metadata: {},
			children: [
				{
					id: 'web-agent',
					title: 'Web agent — Me',
					icon: 'lucide:monitor-user',
					metadata: {},
					children: [
						{
							id: 'chat',
							title: 'Skills discussion',
							icon: 'lucide:message-square',
							metadata: {}
						}
					]
				}
			]
		}
	];
</script>

<TreeSelect rootItems={items} showSearch />
