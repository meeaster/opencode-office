// Forwards WSL's 127.0.0.1:<port> to Windows' 127.0.0.1:<port> through WSL interop: each connection starts a
// Windows node.exe (or bun.exe) that dials the Windows-local port, so nothing listens on a network interface.
//
//   bun cdp-relay.ts <port> <WSL path to a Windows node.exe or bun.exe>
import { spawn } from "node:child_process";
import { createServer } from "node:net";

const [port, windowsRuntime] = process.argv.slice(2);

if (port === undefined || windowsRuntime === undefined) {
  console.error("usage: bun cdp-relay.ts <port> <WSL path to a Windows node.exe or bun.exe>");
  process.exit(2);
}

const bridge = `const s=require("net").connect(${Number(port)},"127.0.0.1");process.stdin.pipe(s);s.pipe(process.stdout);s.on("close",()=>process.exit(0));s.on("error",()=>process.exit(1))`;

createServer((socket) => {
  const child = spawn(windowsRuntime, ["-e", bridge], { stdio: ["pipe", "pipe", "ignore"] });

  socket.pipe(child.stdin);
  child.stdout.pipe(socket);
  child.on("exit", () => socket.destroy());
  child.on("error", () => socket.destroy());
  socket.on("close", () => child.kill());
  socket.on("error", () => child.kill());
}).listen(Number(port), "127.0.0.1", () => console.error(`relay listening on 127.0.0.1:${port}`));
