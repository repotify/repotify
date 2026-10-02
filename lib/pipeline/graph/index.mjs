// Capability graph pipeline: loader + consistency check + resolver.
export * from "./loader.mjs";
export { auditGraph } from "./check.mjs";
export { providersFor, candidatesFor, expandDependencies, MAX_FALLBACK_DEPTH } from "./resolve.mjs";
