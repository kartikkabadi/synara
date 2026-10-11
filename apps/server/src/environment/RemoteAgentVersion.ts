// FILE: RemoteAgentVersion.ts
// Purpose: The remote agent protocol version this server speaks. Must match
//          PROTOCOL_VERSION in apps/remote-agent/src/version.ts; the hello
//          handshake and the installer both fail closed on any mismatch, so
//          drift is caught on first connect.
// Layer: Server utility (no IO; safe to import from anywhere)

export const REMOTE_AGENT_PROTOCOL_VERSION = "0.1.0";
