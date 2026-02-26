// ============================================================================
// Verifiers Barrel — The drop-in verifier registration pattern.
// PSEUDO-CODE: Conceptual pattern. Adapt to your language.
//
// Same pattern as tools: one file to edit, auto-discovery.
// ============================================================================

// ── verifiers.exports.ts (or equivalent) ─────────────────────────────────────
//
// THE ONLY FILE TO EDIT WHEN ADDING A VERIFIER.
// One export per verifier. Order categories: A, C, I, R, U.

export { SourceAttributionVerifier } from './source-attribution.verifier';
export { ConcentrationRiskVerifier } from './concentration-risk.verifier';
export { StaleDataVerifier } from './stale-data.verifier';
// export { YourVerifier } from './your-verifier.verifier';   ← add one line here


// ── verification/index.ts (auto-derives ALL_VERIFIERS — NEVER edit manually) ─
//
// import * as verifierExports from './verifiers.exports';
// export const ALL_VERIFIERS: Verifier[] = Object.values(verifierExports)
//   .filter((V): V is new () => Verifier => typeof V === 'function')
//   .map((V) => new V());
//
// The verification pipeline loads ALL_VERIFIERS, sorts by order, runs in sequence.
