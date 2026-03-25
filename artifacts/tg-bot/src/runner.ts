import { spawn, ChildProcess, execSync, exec } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { updateDeploymentStatus, getEnvs } from "./database.js";

interface RunningProcess {
  process: ChildProcess;
  startedAt: Date;
  port?: number;
  type: string;
  projectDir: string;
  entryFile: string | null;
}

const running = new Map<string, RunningProcess>();
const logs = new Map<string, string[]>();
const lastExitCode = new Map<string, number | null>();

const MAX_LOG_LINES = 300;
let nextPort = 4000;

function getNextPort(): number {
  const usedPorts = new Set(Array.from(running.values()).map((e) => e.port).filter(Boolean));
  while (usedPorts.has(nextPort)) nextPort++;
  return nextPort++;
}

function initLogs(id: string) {
  if (!logs.has(id)) logs.set(id, []);
}
function appendLog(id: string, line: string) {
  initLogs(id);
  const arr = logs.get(id)!;
  arr.push(line);
  if (arr.length > MAX_LOG_LINES) arr.shift();
}

export function getLogs(id: string): string[] { return logs.get(id) ?? []; }
export function clearLogs(id: string) { logs.set(id, []); }
export function isRunning(id: string): boolean { return running.has(id); }
export function getPort(id: string): number | undefined { return running.get(id)?.port; }
export function getLastExitCode(id: string): number | null | undefined { return lastExitCode.get(id); }

// ── Python path ───────────────────────────────────────────────────────────────
function resolvePython(): string {
  const candidates = [
    "/home/runner/workspace/.pythonlibs/bin/python3",
    "/usr/bin/python3",
    "/usr/local/bin/python3",
  ];
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  try { return execSync("which python3", { encoding: "utf8" }).trim(); } catch {}
  return "python3";
}
const PYTHON_BIN = resolvePython();
const PIP_BIN = PYTHON_BIN.replace("python3", "pip3");

// ── Public URL ────────────────────────────────────────────────────────────────
export function buildPublicUrl(port: number): string {
  const domain = process.env.REPLIT_DEV_DOMAIN ?? process.env.REPLIT_DOMAINS ?? "";
  if (domain) return `https://${port}-${domain}`;
  return `http://localhost:${port}`;
}

// ── Missing module detection ──────────────────────────────────────────────────
export function detectMissingModules(logLines: string[]): string[] {
  const missing = new Set<string>();
  const patterns = [
    /ModuleNotFoundError: No module named '([^']+)'/,
    /ImportError: No module named '([^']+)'/,
    /ImportError: cannot import name .+ from '([^']+)'/,
    /No module named ([^\s']+)/,
  ];
  for (const line of logLines) {
    for (const pat of patterns) {
      const m = line.match(pat);
      if (m) {
        // module names like 'aiohttp.web' → install 'aiohttp'
        missing.add(m[1].split(".")[0]);
      }
    }
  }
  return Array.from(missing);
}

// ── Install Python packages ───────────────────────────────────────────────────
export async function installPythonPackages(packages: string[]): Promise<{ success: boolean; output: string }> {
  return new Promise((resolve) => {
    const pip = fs.existsSync(PIP_BIN) ? PIP_BIN : `${PYTHON_BIN} -m pip`;
    const cmd = `${pip} install ${packages.join(" ")} --quiet 2>&1`;
    exec(cmd, { env: { ...process.env, PATH: `/home/runner/workspace/.pythonlibs/bin:${process.env.PATH}` } }, (err, stdout, stderr) => {
      const output = (stdout + stderr).trim();
      resolve({ success: !err, output });
    });
  });
}

// ── Send command to stdin ─────────────────────────────────────────────────────
export function sendCommand(id: string, text: string): boolean {
  const entry = running.get(id);
  if (!entry || !entry.process.stdin) return false;
  try {
    entry.process.stdin.write(text + "\n");
    appendLog(id, `[IN] ${text}`);
    return true;
  } catch {
    return false;
  }
}

// ── File helpers ──────────────────────────────────────────────────────────────
function findFile(dir: string, extensions: string[]): string | null {
  try {
    const files = fs.readdirSync(dir);
    for (const ext of extensions) {
      const file = files.find((f) => f.toLowerCase().endsWith(ext));
      if (file) return path.join(dir, file);
    }
  } catch {}
  return null;
}

async function buildDocker(imageName: string, contextDir: string): Promise<{ success: boolean; message: string }> {
  return new Promise((resolve) => {
    const proc = spawn("docker", ["build", "-t", imageName, "."], { cwd: contextDir, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    proc.stdout?.on("data", (d: Buffer) => (output += d.toString()));
    proc.stderr?.on("data", (d: Buffer) => (output += d.toString()));
    proc.on("exit", (code) => resolve({ success: code === 0, message: output.slice(-800) }));
    proc.on("error", (err) => resolve({ success: false, message: err.message }));
  });
}

// ── Start project ─────────────────────────────────────────────────────────────
export async function startProject(
  id: string,
  type: string,
  projectDir: string,
  entryFile: string | null
): Promise<{ success: boolean; completed?: boolean; message: string; port?: number; url?: string; missingModules?: string[] }> {
  if (running.has(id)) return { success: false, message: "Already running." };
  if (!fs.existsSync(projectDir)) return { success: false, message: "Project files not found." };

  const envVars = await getEnvs(id);
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  env["PATH"] = `/home/runner/workspace/.pythonlibs/bin:${env["PATH"] ?? "/usr/bin:/bin"}`;
  env["PYTHONPATH"] = `/home/runner/workspace/.pythonlibs/lib/python3.11/site-packages`;
  for (const { key, value } of envVars) env[key] = value;

  let cmd: string;
  let args: string[];
  let port: number | undefined;

  switch (type) {
    case "python": {
      const entry = entryFile && fs.existsSync(entryFile) ? entryFile : findFile(projectDir, [".py"]);
      if (!entry) return { success: false, message: "No Python (.py) file found in project." };
      cmd = PYTHON_BIN;
      args = ["-u", entry];
      break;
    }
    case "html": {
      port = getNextPort();
      env["PORT"] = String(port);
      cmd = PYTHON_BIN;
      args = ["-m", "http.server", String(port), "--directory", projectDir];
      break;
    }
    case "nodejs": {
      const entry = entryFile && fs.existsSync(entryFile) ? entryFile : findFile(projectDir, [".js", ".mjs", ".cjs"]);
      if (!entry) return { success: false, message: "No Node.js (.js) file found in project." };
      cmd = "node";
      args = [entry];
      break;
    }
    case "shell": {
      const entry = entryFile && fs.existsSync(entryFile) ? entryFile : findFile(projectDir, [".sh"]);
      if (!entry) return { success: false, message: "No shell script (.sh) found in project." };
      cmd = "bash";
      args = [entry];
      break;
    }
    case "docker": {
      if (!fs.existsSync(path.join(projectDir, "Dockerfile"))) {
        return { success: false, message: "No Dockerfile found in project directory." };
      }
      port = getNextPort();
      env["PORT"] = String(port);
      const imageName = `tgbot-${id.slice(0, 8)}`;
      const buildResult = await buildDocker(imageName, projectDir);
      if (!buildResult.success) return { success: false, message: `Docker build failed:\n${buildResult.message}` };
      cmd = "docker";
      args = ["run", "--rm", "-p", `${port}:${port}`, "-e", `PORT=${port}`,
        ...envVars.flatMap(({ key, value }) => ["-e", `${key}=${value}`]), imageName];
      break;
    }
    default:
      return { success: false, message: `Unsupported project type: ${type}` };
  }

  clearLogs(id);
  lastExitCode.delete(id);
  appendLog(id, `[SYS] Starting ${type} project...`);

  // Use pipe for stdin so we can send commands
  const proc = spawn(cmd, args, { cwd: projectDir, env, stdio: ["pipe", "pipe", "pipe"] });

  const entry: RunningProcess = { process: proc, startedAt: new Date(), port, type, projectDir, entryFile };
  running.set(id, entry);

  proc.stdout?.on("data", (data: Buffer) => {
    for (const line of data.toString().split("\n").filter(Boolean)) appendLog(id, `[OUT] ${line}`);
  });
  proc.stderr?.on("data", (data: Buffer) => {
    for (const line of data.toString().split("\n").filter(Boolean)) appendLog(id, `[ERR] ${line}`);
  });
  proc.on("exit", (code) => {
    appendLog(id, `[SYS] Process exited with code ${code}`);
    lastExitCode.set(id, code);
    running.delete(id);
    updateDeploymentStatus(id, "stopped").catch(() => {});
  });
  proc.on("error", (err) => {
    appendLog(id, `[SYS] Failed to launch: ${err.message}`);
    lastExitCode.set(id, -1);
    running.delete(id);
    updateDeploymentStatus(id, "stopped").catch(() => {});
  });

  await new Promise((r) => setTimeout(r, 1000));

  if (!running.has(id)) {
    const exitCode = lastExitCode.get(id) ?? -1;
    const outputLines = getLogs(id);
    const outputText = outputLines.join("\n");

    if (exitCode === 0) {
      return { success: true, completed: true, message: `Script completed.\n\nOutput:\n${outputText.slice(-600)}` };
    }

    // Check for missing modules
    const missingModules = detectMissingModules(outputLines);
    return {
      success: false,
      message: `Process crashed (exit code ${exitCode}).\n\nOutput:\n${outputText.slice(-600)}`,
      missingModules: missingModules.length > 0 ? missingModules : undefined,
    };
  }

  const url = port ? buildPublicUrl(port) : undefined;
  await updateDeploymentStatus(id, "running", port);
  return { success: true, message: "Started successfully.", port, url };
}

// ── Stop project ──────────────────────────────────────────────────────────────
export function stopProject(id: string): boolean {
  const entry = running.get(id);
  if (!entry) return false;
  try {
    entry.process.kill("SIGTERM");
    setTimeout(() => { try { entry.process.kill("SIGKILL"); } catch {} }, 5000);
  } catch {}
  running.delete(id);
  return true;
}
