import { RemoteAgent } from "./agent";
import { connectDaemon, runDaemon } from "./daemon";

process.title = "synara-remote-agent";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[1]) {
    if (args[0] === "--connect") return connectDaemon(args[1]);
    if (args[0] === "--daemon") return runDaemon(args[1]);
  }
  if (args.length > 0) throw new Error("Usage: remote-agent [--connect endpoint-id | --daemon endpoint-id]");

  // A one-shot stdio mode remains for installer version probes.
  let stopping = false;
  const shutdown = async (failure?: unknown) => {
    if (stopping) return;
    stopping = true;
    let code = failure ? 1 : 0;
    if (failure) process.stderr.write(`synara-remote-agent: ${String(failure)}\n`);
    try {
      await agent.shutdown();
    } catch (error) {
      code = 1;
      process.stderr.write(`synara-remote-agent: cleanup failed: ${String(error)}\n`);
    }
    process.exit(code);
  };
  const agent = new RemoteAgent(process.stdout, { onFatal: (error) => { void shutdown(error); } });
  agent.attachInput(process.stdin);
  process.stdin.once("end", () => { void shutdown(); });
  process.on("SIGINT", () => { void shutdown(); });
  process.on("SIGTERM", () => { void shutdown(); });
  process.on("uncaughtException", (error) => { void shutdown(error); });
  process.on("unhandledRejection", (error) => { void shutdown(error); });
}

void main().catch((error: unknown) => {
  process.stderr.write(`synara-remote-agent: ${String(error)}\n`);
  process.exitCode = 1;
});
