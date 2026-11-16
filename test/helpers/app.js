// Runs the real app.js in a child process (temp data dir, free port, bot auto-start off,
// network guard) and gives tests a small cookie-aware JSON client for it.
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

// Test files run in parallel: another file can take the "free" port between the probe and
// app.js binding it. app.js then exits (EADDRINUSE), so retry on a new port, and only
// trust the health check while our own child is still alive.
async function spawnOnFreePort(env) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ["--import", "./test/setup.js", "app.js"], {
      cwd: ROOT,
      env: { ...process.env, WEBHOOK_PORT: String(port), BIND_HOST: "127.0.0.1", AUTO_START_BOT: "false", ...env },
      stdio: "ignore",
    });
    let exited = false;
    child.once("exit", () => (exited = true));
    for (let i = 0; i < 100 && !exited; i++) {
      try {
        if ((await fetch(`${base}/api/health`)).ok && !exited) return { child, base };
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    child.kill();
  }
  throw new Error("app.js did not start");
}

export async function startApp(env = {}) {
  const { child, base } = await spawnOnFreePort(env);

  const app = {
    base,
    cookie: "",
    stop: () => child.kill(),
    async call(method, url, body, { auth = true, headers = {} } = {}) {
      const res = await fetch(base + url, {
        method,
        headers: {
          ...(body !== undefined && { "content-type": "application/json" }),
          ...(auth && app.cookie && { cookie: app.cookie }),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {}
      const setCookie = res.headers.get("set-cookie");
      return { status: res.status, json, setCookie, token: setCookie?.match(/auth_token=[^;]+/)?.[0] };
    },
  };
  return app;
}
