/**
 * MCP server that exposes flow-device as tools and records every call to a trace.
 *
 * M0 only reserves the package. Tools and the recorder land in M1;
 * see research/record-replay-prototype-design.md §4.1 and §5.2.
 */

/** When set, the server records a trace to this directory without agent cooperation. */
export const TRACE_DIR_ENV = 'FLOW_TRACE_DIR'
