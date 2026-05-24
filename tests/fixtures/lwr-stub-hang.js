#!/usr/bin/env node
/**
 * Stand-in for `lwr` that hangs indefinitely. Used to exercise the
 * dispatcher's timeout/SIGTERM path (dispatch.ts:107-110). The test
 * uses a small `timeoutMs` override so it doesn't actually wait
 * MCP_DISPATCH_TIMEOUT_MS seconds.
 */
// Keep the event loop alive forever.
setInterval(() => {}, 1_000);
