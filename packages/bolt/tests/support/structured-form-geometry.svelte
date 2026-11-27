<script lang="ts">
	import type { UiContext } from '@norbital-ai/ui';
	import { FieldControl, Label, Section, StructuredData } from '@norbital-ai/ui';
	import { Columns, Stack } from '@norbital-ai/ui/layout';

	let { ctx }: { ctx: UiContext } = $props();

	const conversions = {
		day: { days: 21.75, basis: 'FIXED' },
		hour: { basis: 'FIXED', hours: 174 },
		rounding: { mode: 'HALF_UP', scale: 2 },
		proration: 'DAY_RATE'
	};
	const nested = {
		outer: {
			inner: {
				leaf: 'value'
			}
		}
	};
</script>

<div class="p-6" data-geometry-harness>
	<Stack gap="md">
		<Section first name="def" title="Definition" icon="lucide:file-text">
			<Columns count={2} gap="md">
				<FieldControl id="geom-code" label="Code" readonly>
					<span class="text-sm text-foreground" data-data-value>FINAL_WAGES</span>
				</FieldControl>
				<Stack gap="xs">
					<Label for="geom-bare-input" data-bare-label>Bare label</Label>
					<span id="geom-bare-input" class="text-sm text-foreground">Data</span>
				</Stack>
			</Columns>
		</Section>

		<Section name="reads" title="Reads" icon="lucide:database">
			<FieldControl id="geom-reads" label="Reads" readonly>
				<div data-reads-body>holiday</div>
			</FieldControl>
		</Section>

		<Section name="conversions" title="Conversions" icon="lucide:arrow-left-right">
			<div data-conversions>
				<StructuredData {ctx} name="conversions" mode="view" kind={{ kind: 'json' }} value={conversions} />
			</div>
		</Section>

		<Section name="deep" title="Deep" icon="lucide:layers">
			<div data-deep>
				<StructuredData {ctx} name="deep" mode="view" kind={{ kind: 'json' }} value={nested} />
			</div>
		</Section>
	</Stack>
</div>
