// forge-service.js implements buildSidecarContext and createSidecarRouter.
// These functions are re-exported by sidecar.js and declared there to avoid duplication.
export { buildSidecarContext, createSidecarRouter } from './sidecar.js';
export type { SidecarContext, SidecarOptions } from './sidecar.js';
