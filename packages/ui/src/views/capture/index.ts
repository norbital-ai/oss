// `@norbital-ai/ui/capture` (§3.6): its own entry, so the face engine and weights load only in pages that import it.
export { default as CaptureKit, type CaptureKitProps, type Captured, type FaceFrame } from './CaptureKit.svelte';
export { POSES, type Pose, type Voice } from './capture.js';
