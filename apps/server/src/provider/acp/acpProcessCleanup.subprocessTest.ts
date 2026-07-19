import { spawn } from "node:child_process";
import { trackAcpProcess, untrackAcpProcess } from "./acpProcessCleanup.ts";

const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
const childPid = child.pid;
if (!childPid) {
  throw new Error("Failed to spawn tracked child");
}

trackAcpProcess(childPid);
child.on("exit", () => untrackAcpProcess(childPid));
process.stdout.write(`ready ${childPid}\n`);
