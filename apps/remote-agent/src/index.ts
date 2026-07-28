import { RemoteAgent } from "./agent";

process.title = "synara-remote-agent";

const agent = new RemoteAgent(process.stdout);
agent.attachInput(process.stdin);

process.on("SIGINT", () => agent.shutdown());
process.on("SIGTERM", () => agent.shutdown());
process.on("uncaughtException", (error) => {
  process.stderr.write(`synara-remote-agent: ${error.stack ?? error.message}\n`);
});
