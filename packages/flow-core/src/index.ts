/**
 * Flow script schema, compiler (trace → flow) and replayer.
 *
 * M0 only reserves the package. The schema, compiler and replayer land in M2;
 * see research/record-replay-prototype-design.md §4.2, §5.3 and §5.4.
 */
export const FLOW_SCHEMA_VERSION = 1

export type { Selector } from '@escrcpy/flow-device'
