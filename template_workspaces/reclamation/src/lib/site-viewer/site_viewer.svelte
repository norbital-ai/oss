<script lang="ts">
	import { Bound, Inline } from '@norbital-ai/ui/layout';
	import { onDestroy } from 'svelte';
	import { watch } from 'runed';
	import workerUrl from './site_viewer.worker.ts?worker&url';
	import type {
		SiteSurfaces,
		SiteViewerProps,
		SurfaceMesh,
		ThreeCamera,
		ThreeControls,
		ThreeMaterial,
		ThreeModule,
		ThreeObject3D,
		ThreeRenderer
	} from './site_viewer.types.js';

	let { model, label, visible, renderCellM, onLayers, onStats }: SiteViewerProps = $props();

	const runtime: Promise<
		[
			ThreeModule,
			{ OrbitControls: new (camera: ThreeCamera, element: HTMLElement) => ThreeControls }
		]
	> = Promise.all([
		import(/* @vite-ignore */ 'https://esm.sh/three@0.185.1'),
		import(/* @vite-ignore */ 'https://esm.sh/three@0.185.1/examples/jsm/controls/OrbitControls.js')
	]);

	type Stage = {
		THREE: ThreeModule;
		renderer: ThreeRenderer;
		scene: ThreeObject3D & { background: { set(value: number | string): unknown } | null };
		camera: ThreeCamera;
		controls: ThreeControls;
		group: ThreeObject3D;
		materials: ThreeMaterial[];
		frame: number;
	};

	let container = $state<HTMLDivElement | null>(null);
	let status = $state<'idle' | 'building' | 'ready' | { error: string }>('idle');
	let surfaces = $state<SiteSurfaces | null>(null);
	let stage: Stage | null = null;

	const isVisible = (id: string): boolean => visible?.[id] ?? true;

	/**
	 * Rebuild the surfaces whenever the model identity changes.
	 *
	 * The worker is created per build and terminated after it answers: a stitch is
	 * an occasional event, and a resident worker holding a copy of the survey grid
	 * is not worth the memory.
	 */
	async function buildSurfaces(current: typeof model): Promise<void> {
		status = 'building';
		try {
			const built = await requestSurfaces(current);
			surfaces = built;
			onLayers?.(
				built.meshes.map((mesh) => ({
					id: mesh.id,
					label: mesh.label,
					color: `#${mesh.color.toString(16).padStart(6, '0')}`,
					triangles: mesh.indices.length / 3
				}))
			);
			onStats?.({
				vertexCount: built.vertexCount,
				triangleCount: built.triangleCount,
				renderCellM: built.renderCellM
			});
			if (stage) applySurfaces(stage, built);
			status = 'ready';
		} catch (error) {
			status = { error: error instanceof Error ? error.message : String(error) };
		}
	}

	async function requestSurfaces(current: typeof model): Promise<SiteSurfaces> {
		let worker: Worker;
		try {
			// A sandboxed iframe blocks a direct worker URL, so the script is fetched
			// and handed to the worker as a blob, as elsewhere in the platform.
			const response = await fetch(new URL(workerUrl, import.meta.url).href);
			const blob = new Blob([await response.text()], { type: 'application/javascript' });
			worker = new Worker(URL.createObjectURL(blob), { name: 'reclamation-tessellator' });
		} catch {
			const { buildSurfaces: buildOnMainThread } = await import('../reclamation/solids.js');
			return buildOnMainThread(
				renderCellM ? { ...current, settings: { ...current.settings, renderCellM } } : current
			);
		}

		return new Promise<SiteSurfaces>((resolve, reject) => {
			worker.onmessage = (
				event: MessageEvent<{ type: string; surfaces?: SiteSurfaces; error?: string }>
			) => {
				if (event.data.type === 'ready') return;
				worker.terminate();
				if (event.data.type === 'surfaces' && event.data.surfaces) resolve(event.data.surfaces);
				else reject(new Error(event.data.error ?? 'The tessellation worker failed.'));
			};
			worker.onerror = (event) => {
				worker.terminate();
				reject(new Error(event.message || 'The tessellation worker failed to start.'));
			};
			worker.postMessage({ type: 'build', model: current, renderCellM });
		});
	}

	function readCssColor(name: string, fallback: string): string {
		if (typeof document === 'undefined') return fallback;
		const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
		return value || fallback;
	}

	async function mountStage(node: HTMLDivElement): Promise<void> {
		const [THREE, { OrbitControls }] = await runtime;
		const renderer = new THREE.WebGLRenderer({
			antialias: true,
			powerPreference: 'high-performance'
		});
		renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2));
		renderer.setSize(node.clientWidth || 1, node.clientHeight || 1);
		renderer.setClearColor(readCssColor('--color-background', '#f2f1ed'), 1);
		node.appendChild(renderer.domElement);
		renderer.domElement.style.width = '100%';
		renderer.domElement.style.height = '100%';
		renderer.domElement.style.display = 'block';

		const scene = new THREE.Scene();
		const camera = new THREE.PerspectiveCamera(
			45,
			(node.clientWidth || 1) / (node.clientHeight || 1),
			1,
			200_000
		);
		const controls = new OrbitControls(camera, renderer.domElement);
		controls.enableDamping = true;
		controls.dampingFactor = 0.08;
		controls.maxPolarAngle = Math.PI / 2.02;

		scene.add(new THREE.HemisphereLight(0xdfe7ef, 0x39433b, 1.05));
		const sun = new THREE.DirectionalLight(0xffffff, 1.6);
		sun.position.set(1, 2, 1);
		scene.add(sun);
		scene.add(new THREE.AmbientLight(0xffffff, 0.25));

		const group = new THREE.Group();
		// Engineering frame (X alongshore, Y seaward, Z up) → the renderer's Y-up frame.
		group.rotation.x = -Math.PI / 2;
		scene.add(group);

		stage = { THREE, renderer, scene, camera, controls, group, materials: [], frame: 0 };
		if (surfaces) applySurfaces(stage, surfaces);

		const observer = new ResizeObserver(() => {
			if (!stage) return;
			const width = node.clientWidth || 1;
			const height = node.clientHeight || 1;
			stage.renderer.setSize(width, height);
			stage.camera.aspect = width / height;
			stage.camera.updateProjectionMatrix();
		});
		observer.observe(node);
		resizeObserver = observer;

		const tick = (): void => {
			if (!stage) return;
			stage.frame = requestAnimationFrame(tick);
			stage.controls.update();
			stage.renderer.render(stage.scene, stage.camera);
		};
		tick();
	}

	function applySurfaces(current: Stage, next: SiteSurfaces): void {
		const { THREE, group } = current;
		group.traverse((object) => {
			const mesh = object as { geometry?: { dispose(): void } };
			mesh.geometry?.dispose();
		});
		for (const material of current.materials) material.dispose();
		current.materials = [];
		group.clear();

		for (const mesh of next.meshes) {
			group.add(createMesh(THREE, current, mesh));
		}
		for (const cut of next.cuts) {
			const geometry = new THREE.BufferGeometry();
			geometry.setAttribute('position', new THREE.BufferAttribute(cut.points, 3));
			const material = new THREE.LineBasicMaterial({ color: 0xf0a94b });
			current.materials.push(material);
			const line = new THREE.Line(geometry, material);
			line.name = `cut:${cut.id}`;
			line.renderOrder = 3;
			group.add(line);
		}
		frameCamera(current, next);
	}

	function createMesh(THREE: ThreeModule, current: Stage, source: SurfaceMesh) {
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute('position', new THREE.BufferAttribute(source.positions, 3));
		geometry.setAttribute('normal', new THREE.BufferAttribute(source.normals, 3));
		geometry.setIndex(new THREE.BufferAttribute(source.indices, 1));
		geometry.computeBoundingSphere();
		const material = new THREE.MeshStandardMaterial({
			color: source.color,
			roughness: source.id === 'sea' ? 0.15 : 0.95,
			metalness: 0,
			transparent: source.opacity < 1,
			opacity: source.opacity,
			side: source.doubleSided ? THREE.DoubleSide : THREE.FrontSide
		});
		current.materials.push(material);
		const mesh = new THREE.Mesh(geometry, material);
		mesh.name = source.id;
		mesh.visible = isVisible(source.id);
		mesh.renderOrder = source.id === 'sea' ? 2 : source.id === 'structure' ? 1 : 0;
		return mesh;
	}

	function frameCamera(current: Stage, next: SiteSurfaces): void {
		const { bounds } = next;
		const centreX = (bounds.minX + bounds.maxX) / 2;
		const centreY = (bounds.minY + bounds.maxY) / 2;
		const centreZ = (bounds.minZ + bounds.maxZ) / 2;
		const radius =
			Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, bounds.maxZ - bounds.minZ) / 2;
		const distance = Math.max(radius * 2.1, 100);
		current.controls.target.set(centreX, centreZ, -centreY);
		current.camera.position.set(
			centreX - distance * 0.55,
			centreZ + distance * 0.55,
			-centreY + distance * 0.7
		);
		current.camera.near = Math.max(0.5, distance / 5000);
		current.camera.far = distance * 20;
		current.camera.updateProjectionMatrix();
		current.controls.minDistance = radius * 0.05;
		current.controls.maxDistance = distance * 6;
		current.controls.update();
	}

	function resetView(): void {
		if (stage && surfaces) frameCamera(stage, surfaces);
	}

	let resizeObserver: ResizeObserver | null = null;

	watch(
		() => container,
		(node) => {
			if (!node || stage) return;
			void mountStage(node);
		}
	);
	watch(
		() => [model, renderCellM] as const,
		([current]) => {
			if (current) void buildSurfaces(current);
		}
	);
	// Visibility is applied to the live scene rather than rebuilding anything:
	// toggling a layer must never cost a re-tessellation.
	watch(
		() => visible,
		() => {
			stage?.group.traverse((object) => {
				if (object.name && !object.name.startsWith('cut:')) {
					object.visible = isVisible(object.name);
				}
			});
		}
	);

	onDestroy(() => {
		resizeObserver?.disconnect();
		if (!stage) return;
		cancelAnimationFrame(stage.frame);
		stage.controls.dispose();
		stage.group.traverse((object) => {
			const mesh = object as { geometry?: { dispose(): void } };
			mesh.geometry?.dispose();
		});
		for (const material of stage.materials) material.dispose();
		stage.renderer.dispose();
		stage.renderer.domElement.remove();
		stage = null;
	});
</script>

<Bound size="full" clip class="relative">
	<div
		bind:this={container}
		class="h-full w-full"
		aria-label={label ?? 'Reclamation site model'}
	></div>

	{#if status === 'building' || status === 'idle'}
		<Inline
			align="center"
			justify="center"
			class="absolute inset-0 bg-background/70 text-sm text-muted-foreground"
		>
			Tessellating the stitched solid…
		</Inline>
	{:else if typeof status === 'object'}
		<Inline
			align="center"
			justify="center"
			class="absolute inset-0 bg-background/85 px-6 text-center text-sm text-destructive"
		>
			{status.error}
		</Inline>
	{/if}

	{#if surfaces && status === 'ready'}
		<div
			class="absolute right-3 bottom-3 rounded-md border bg-background/85 px-2 py-1 text-tiny text-muted-foreground shadow-xs backdrop-blur"
		>
			<button type="button" class="font-medium hover:underline" onclick={resetView}>
				Reset view
			</button>
			<span class="mx-1.5">·</span>
			<span class="tabular-nums">
				{surfaces.triangleCount.toLocaleString()} tri · {surfaces.renderCellM.toFixed(1)} m cell
			</span>
		</div>
	{/if}
</Bound>
