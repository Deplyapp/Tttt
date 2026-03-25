import { Telegraf, Markup, Context } from "telegraf";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import axios from "axios";
import AdmZip from "adm-zip";
import { v4 as uuidv4 } from "uuid";
import {
  initDb,
  resetAllRunningToStopped,
  createDeployment,
  getDeployment,
  getUserDeployments,
  updateDeploymentStatus,
  deleteDeployment,
  setEnv,
  removeEnv,
  getEnvs,
} from "./database.js";
import { startProject, stopProject, getLogs, isRunning, getPort, getLastExitCode, buildPublicUrl, sendCommand, installPythonPackages, detectMissingModules } from "./runner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECTS_DIR = path.resolve(__dirname, "../../projects");
fs.mkdirSync(PROJECTS_DIR, { recursive: true });

if (!process.env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN must be set.");

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// ── State machine ─────────────────────────────────────────────────────────────
type UserState =
  | { type: "idle" }
  | { type: "awaiting_file" }
  | { type: "awaiting_env"; deployId: string }
  | { type: "awaiting_remove_env"; deployId: string }
  | { type: "awaiting_command"; deployId: string };

const userState = new Map<number, UserState>();

function getState(userId: number): UserState {
  return userState.get(userId) ?? { type: "idle" };
}
function setState(userId: number, state: UserState) {
  userState.set(userId, state);
}
function clearState(userId: number) {
  userState.set(userId, { type: "idle" });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function shortId(id: string) {
  return id.slice(0, 8);
}

function typeIcon(type: string) {
  const icons: Record<string, string> = {
    python: "🐍",
    html: "🌐",
    nodejs: "🟨",
    shell: "🐚",
    docker: "🐳",
  };
  return icons[type] ?? "📦";
}

function statusIcon(id: string, dbStatus: string) {
  if (isRunning(id)) return "🟢";
  if (dbStatus === "error") return "🟠";
  return "🔴";
}

function projectDir(userId: number, deployId: string): string {
  const dir = path.join(PROJECTS_DIR, String(userId), deployId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function detectType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const base = path.basename(filename).toLowerCase();
  if (base === "dockerfile") return "docker";
  if (ext === ".py") return "python";
  if (ext === ".html" || ext === ".htm") return "html";
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return "nodejs";
  if (ext === ".sh") return "shell";
  return "unknown";
}

function detectTypeFromDir(dir: string): string {
  try {
    const files = fs.readdirSync(dir).map((f) => f.toLowerCase());
    if (files.includes("dockerfile")) return "docker";
    if (files.some((f) => f.endsWith(".py"))) return "python";
    if (files.some((f) => f.endsWith(".html") || f.endsWith(".htm"))) return "html";
    if (files.some((f) => f.endsWith(".js") || f.endsWith(".mjs"))) return "nodejs";
    if (files.some((f) => f.endsWith(".sh"))) return "shell";
  } catch {}
  return "unknown";
}

async function downloadFile(url: string, dest: string) {
  const res = await axios.get(url, { responseType: "arraybuffer" });
  fs.writeFileSync(dest, Buffer.from(res.data));
}

// ── Keyboards ─────────────────────────────────────────────────────────────────
function mainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🚀 Deploy New Project", "menu:deploy")],
    [Markup.button.callback("📋 My Projects", "menu:list")],
    [Markup.button.callback("❓ Help", "menu:help")],
  ]);
}

function projectKeyboard(id: string) {
  const alive = isRunning(id);
  const rows = [];
  if (alive) {
    rows.push([
      Markup.button.callback("⏹️ Stop", `action:stop:${id}`),
      Markup.button.callback("🔄 Restart", `action:restart:${id}`),
    ]);
    rows.push([Markup.button.callback("⌨️ Send Command", `action:cmd:${id}`)]);
  } else {
    rows.push([Markup.button.callback("▶️ Start", `action:start:${id}`)]);
  }
  rows.push([
    Markup.button.callback("📋 Logs", `action:logs:${id}`),
    Markup.button.callback("🔑 Env Vars", `action:envmenu:${id}`),
  ]);
  rows.push([Markup.button.callback("🗑️ Delete", `action:delete_prompt:${id}`)]);
  rows.push([Markup.button.callback("⬅️ Back to Projects", "menu:list")]);
  return Markup.inlineKeyboard(rows);
}

function envMenuKeyboard(deployId: string) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("➕ Add / Update Variable", `action:setenv:${deployId}`)],
    [Markup.button.callback("➖ Remove Variable", `action:removeenv:${deployId}`)],
    [Markup.button.callback("⬅️ Back to Project", `action:info:${deployId}`)],
  ]);
}

// ── Main Menu ─────────────────────────────────────────────────────────────────
async function sendMainMenu(ctx: Context, text?: string) {
  const msg =
    text ??
    "👋 Welcome to *HostBot*!\n\nI can host your Python, HTML, Node.js, Shell, and Docker projects right from Telegram.";
  await ctx.reply(msg, { parse_mode: "Markdown", ...mainMenuKeyboard() });
}

bot.start((ctx) => sendMainMenu(ctx));

bot.action("menu:main", async (ctx) => {
  await ctx.answerCbQuery();
  clearState(ctx.from!.id);
  await ctx.editMessageText(
    "🏠 *Main Menu*\n\nWhat would you like to do?",
    { parse_mode: "Markdown", ...mainMenuKeyboard() }
  );
});

// ── Help ──────────────────────────────────────────────────────────────────────
bot.action("menu:help", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `❓ *HostBot Help*\n\n` +
      `*How to deploy:*\n` +
      `Tap "🚀 Deploy New Project", then send me your file.\n\n` +
      `*Supported file types:*\n` +
      `${typeIcon("python")} Python — \`.py\` file\n` +
      `${typeIcon("html")} HTML — \`.html\` file (served via web server)\n` +
      `${typeIcon("nodejs")} Node.js — \`.js\` file\n` +
      `${typeIcon("shell")} Shell — \`.sh\` script\n` +
      `${typeIcon("docker")} Docker — \`Dockerfile\` or ZIP with Dockerfile\n` +
      `📦 ZIP — auto-detects type from contents\n\n` +
      `*Env Variables:*\n` +
      `Each project can have its own environment variables. Restart is required after changes.\n\n` +
      `*Project IDs:*\n` +
      `Each project has an 8-character ID shown in "My Projects".`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "menu:main")]]) }
  );
});

// ── Deploy ────────────────────────────────────────────────────────────────────
bot.action("menu:deploy", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id;
  setState(userId, { type: "awaiting_file" });
  await ctx.editMessageText(
    `📤 *Deploy a Project*\n\n` +
      `Send me your project file now:\n\n` +
      `${typeIcon("python")} \`.py\` — Python script\n` +
      `${typeIcon("html")} \`.html\` — HTML page\n` +
      `${typeIcon("nodejs")} \`.js\` — Node.js script\n` +
      `${typeIcon("shell")} \`.sh\` — Shell script\n` +
      `${typeIcon("docker")} \`Dockerfile\` — Docker container\n` +
      `📦 \`.zip\` — Project archive (type auto-detected)\n\n` +
      `_Send the file now or press cancel._`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "menu:main")]]),
    }
  );
});

// ── File handler ──────────────────────────────────────────────────────────────
bot.on("document", async (ctx) => {
  const userId = ctx.from!.id;
  const state = getState(userId);

  if (state.type !== "awaiting_file") {
    await ctx.reply(
      "To deploy a project, tap the button below first.",
      mainMenuKeyboard()
    );
    return;
  }

  clearState(userId);
  const doc = ctx.message.document;
  const fileName = doc.file_name ?? "project";

  const statusMsg = await ctx.reply(`⏳ Uploading *${fileName}*...`, { parse_mode: "Markdown" });

  try {
    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    const deployId = uuidv4();
    const dir = projectDir(userId, deployId);
    const destPath = path.join(dir, fileName);

    await downloadFile(fileLink.href, destPath);

    let type: string;
    let entryFile: string | null = null;

    if (fileName.toLowerCase().endsWith(".zip")) {
      await ctx.telegram.editMessageText(
        ctx.chat.id, statusMsg.message_id, undefined,
        "📦 Extracting archive..."
      );
      const zip = new AdmZip(destPath);
      zip.extractAllTo(dir, true);
      fs.unlinkSync(destPath);
      type = detectTypeFromDir(dir);
    } else {
      type = detectType(fileName);
      entryFile = destPath;
    }

    if (type === "unknown") {
      fs.rmSync(dir, { recursive: true, force: true });
      await ctx.telegram.editMessageText(
        ctx.chat.id, statusMsg.message_id, undefined,
        `❌ *Unknown file type.*\n\nSupported: .py, .html, .js, .sh, Dockerfile, or a .zip archive.\n\nTap below to try again.`,
        { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "menu:deploy")]]) }
      );
      return;
    }

    const projectName = path.basename(fileName, path.extname(fileName));

    await createDeployment({
      id: deployId,
      user_id: userId,
      name: projectName,
      type,
      file_path: dir,
      entry_file: entryFile,
    });

    await ctx.telegram.editMessageText(
      ctx.chat.id, statusMsg.message_id, undefined,
      `✅ *Project Deployed!*\n\n` +
        `📁 Name: *${projectName}*\n` +
        `${typeIcon(type)} Type: ${type}\n` +
        `🆔 ID: \`${shortId(deployId)}\`\n\n` +
        `Would you like to start it now?`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("▶️ Start Now", `action:start:${deployId}`)],
          [
            Markup.button.callback("🔑 Set Env Vars", `action:envmenu:${deployId}`),
            Markup.button.callback("📋 My Projects", "menu:list"),
          ],
          [Markup.button.callback("🏠 Main Menu", "menu:main")],
        ]),
      }
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.telegram.editMessageText(
      ctx.chat.id, statusMsg.message_id, undefined,
      `❌ Upload failed: ${msg}`,
      { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("⬅️ Try Again", "menu:deploy")]]) }
    );
  }
});

// ── Text handler (for env vars input) ─────────────────────────────────────────
bot.on("text", async (ctx) => {
  const userId = ctx.from!.id;
  const state = getState(userId);
  const text = ctx.message.text.trim();

  if (text.startsWith("/")) return; // let command handlers deal with it

  if (state.type === "awaiting_env") {
    clearState(userId);
    const deployId = state.deployId;

    if (!text.includes("=")) {
      await ctx.reply(
        `❌ Invalid format. Use \`KEY=VALUE\`.\n\nExample: \`PORT=3000\``,
        {
          parse_mode: "Markdown",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("⬅️ Env Vars", `action:envmenu:${deployId}`)],
          ]),
        }
      );
      return;
    }

    const eqIdx = text.indexOf("=");
    const key = text.slice(0, eqIdx).trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
    const value = text.slice(eqIdx + 1).trim();

    if (!key) {
      await ctx.reply("❌ Key cannot be empty.", {
        ...Markup.inlineKeyboard([[Markup.button.callback("⬅️ Env Vars", `action:envmenu:${deployId}`)]]),
      });
      return;
    }

    await setEnv(deployId, key, value);
    await ctx.reply(
      `✅ Set \`${key}\` = \`${value}\`\n\nRestart the project for changes to take effect.`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback("🔄 Restart Now", `action:restart:${deployId}`),
            Markup.button.callback("🔑 Env Vars", `action:envmenu:${deployId}`),
          ],
          [Markup.button.callback("⬅️ Project", `action:info:${deployId}`)],
        ]),
      }
    );
    return;
  }

  if (state.type === "awaiting_remove_env") {
    clearState(userId);
    const deployId = state.deployId;
    const key = text.toUpperCase().trim();
    await removeEnv(deployId, key);
    await ctx.reply(
      `✅ Removed \`${key}\`.\n\nRestart the project for changes to take effect.`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🔑 Env Vars", `action:envmenu:${deployId}`)],
          [Markup.button.callback("⬅️ Project", `action:info:${deployId}`)],
        ]),
      }
    );
    return;
  }

  if (state.type === "awaiting_command") {
    clearState(userId);
    const deployId = state.deployId;
    const d = await getDeployment(deployId);
    if (!d || d.user_id !== userId) {
      await ctx.reply("Project not found.");
      return;
    }

    if (!isRunning(d.id)) {
      await ctx.reply(
        `❌ *${d.name}* is not running. Start it first.`,
        {
          parse_mode: "Markdown",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("▶️ Start", `action:start:${deployId}`)],
            [Markup.button.callback("⬅️ Back to Project", `action:info:${deployId}`)],
          ]),
        }
      );
      return;
    }

    const sent = sendCommand(d.id, text);
    if (sent) {
      await ctx.reply(
        `✅ Sent: \`${text}\`\n\n_Check logs to see the response._`,
        {
          parse_mode: "Markdown",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("⌨️ Send Another", `action:cmd:${deployId}`)],
            [Markup.button.callback("📋 View Logs", `action:logs:${deployId}`)],
            [Markup.button.callback("⬅️ Back to Project", `action:info:${deployId}`)],
          ]),
        }
      );
    } else {
      await ctx.reply(
        `❌ Could not send command — process may not support stdin.`,
        {
          ...Markup.inlineKeyboard([
            [Markup.button.callback("⬅️ Back to Project", `action:info:${deployId}`)],
          ]),
        }
      );
    }
    return;
  }

  // Default: show main menu
  await ctx.reply("Use the menu below to navigate:", mainMenuKeyboard());
});

// ── Project List ──────────────────────────────────────────────────────────────
bot.action("menu:list", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id;
  const deployments = await getUserDeployments(userId);

  if (deployments.length === 0) {
    await ctx.editMessageText(
      "📭 *No projects yet.*\n\nDeploy your first project to get started!",
      { parse_mode: "Markdown", ...Markup.inlineKeyboard([
        [Markup.button.callback("🚀 Deploy Now", "menu:deploy")],
        [Markup.button.callback("🏠 Main Menu", "menu:main")],
      ]) }
    );
    return;
  }

  const buttons = deployments.map((d) => {
    const icon = statusIcon(d.id, d.status);
    const tIcon = typeIcon(d.type);
    return [Markup.button.callback(`${icon} ${tIcon} ${d.name}`, `action:info:${d.id}`)];
  });

  buttons.push([Markup.button.callback("🚀 Deploy New", "menu:deploy")]);
  buttons.push([Markup.button.callback("🏠 Main Menu", "menu:main")]);

  await ctx.editMessageText(
    `📋 *Your Projects* (${deployments.length})\n\n🟢 Running  🔴 Stopped\n\nTap a project to manage it:`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) }
  );
});

// ── Project Info ──────────────────────────────────────────────────────────────
bot.action(/^action:info:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const deployId = ctx.match[1];
  const userId = ctx.from!.id;
  const d = await getDeployment(deployId);
  if (!d || d.user_id !== userId) return ctx.answerCbQuery("Not found.");

  const running = isRunning(d.id);
  const port = getPort(d.id);
  const status = running ? "🟢 Running" : "🔴 Stopped";

  let text =
    `${typeIcon(d.type)} *${d.name}*\n\n` +
    `🆔 ID: \`${shortId(d.id)}\`\n` +
    `⚙️ Type: ${d.type}\n` +
    `📊 Status: ${status}\n`;
  if (running && port) {
    const url = buildPublicUrl(port);
    text += `🌐 URL: ${url}\n`;
  }
  text += `📅 Created: ${d.created_at.toLocaleDateString()}`;

  await ctx.editMessageText(text, { parse_mode: "Markdown", ...projectKeyboard(d.id) });
});

// ── Start ─────────────────────────────────────────────────────────────────────
bot.action(/^action:start:(.+)$/, async (ctx) => {
  const deployId = ctx.match[1];
  const userId = ctx.from!.id;
  const d = await getDeployment(deployId);
  if (!d || d.user_id !== userId) { await ctx.answerCbQuery("Not found."); return; }
  await ctx.answerCbQuery("Starting...");

  await ctx.editMessageText(`⏳ Starting *${d.name}*...`, { parse_mode: "Markdown" });

  const result = await startProject(d.id, d.type, d.file_path, d.entry_file);

  if (result.success && result.completed) {
    // Script ran and exited cleanly (e.g. a simple print script)
    const output = result.message.slice(0, 900);
    await ctx.editMessageText(
      `✅ *${d.name}* ran successfully!\n\n\`\`\`\n${output}\n\`\`\``,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("▶️ Run Again", `action:start:${d.id}`)],
          [Markup.button.callback("📋 Full Logs", `action:logs:${d.id}`)],
          [Markup.button.callback("⬅️ Back to Project", `action:info:${d.id}`)],
        ]),
      }
    );
  } else if (result.success) {
    // Long-running process (web server, bot, etc.)
    let text = `✅ *${d.name}* is running!\n\n🆔 ID: \`${shortId(d.id)}\``;
    if (result.url) text += `\n🌐 URL: ${result.url}`;
    else if (result.port) text += `\n🔌 Port: \`${result.port}\``;
    await ctx.editMessageText(text, { parse_mode: "Markdown", ...projectKeyboard(d.id) });
  } else {
    // Crashed with non-zero exit code
    const crashText = result.message.slice(0, 800);
    const buttons: ReturnType<typeof Markup.button.callback>[][] = [];

    if (result.missingModules && result.missingModules.length > 0) {
      const moduleList = result.missingModules.join(", ");
      buttons.push([
        Markup.button.callback(
          `🔧 Auto-install "${moduleList}" & Retry`,
          `action:autoinstall:${d.id}:${result.missingModules.join(",")}`
        ),
      ]);
    }

    buttons.push([Markup.button.callback("🔑 Set Env Vars", `action:envmenu:${d.id}`)]);
    buttons.push([
      Markup.button.callback("▶️ Retry", `action:start:${d.id}`),
      Markup.button.callback("📋 Full Logs", `action:logs:${d.id}`),
    ]);
    buttons.push([Markup.button.callback("⬅️ Back to Project", `action:info:${d.id}`)]);

    await ctx.editMessageText(
      `❌ *${d.name}* crashed\n\n\`\`\`\n${crashText}\n\`\`\``,
      { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) }
    );
  }
});

// ── Stop ──────────────────────────────────────────────────────────────────────
bot.action(/^action:stop:(.+)$/, async (ctx) => {
  const deployId = ctx.match[1];
  const userId = ctx.from!.id;
  const d = await getDeployment(deployId);
  if (!d || d.user_id !== userId) { await ctx.answerCbQuery("Not found."); return; }
  await ctx.answerCbQuery("Stopping...");

  stopProject(d.id);
  await updateDeploymentStatus(d.id, "stopped");

  await ctx.editMessageText(
    `⏹️ *${d.name}* has been stopped.\n\n🆔 ID: \`${shortId(d.id)}\``,
    { parse_mode: "Markdown", ...projectKeyboard(d.id) }
  );
});

// ── Restart ───────────────────────────────────────────────────────────────────
bot.action(/^action:restart:(.+)$/, async (ctx) => {
  const deployId = ctx.match[1];
  const userId = ctx.from!.id;
  const d = await getDeployment(deployId);
  if (!d || d.user_id !== userId) { await ctx.answerCbQuery("Not found."); return; }
  await ctx.answerCbQuery("Restarting...");

  await ctx.editMessageText(`🔄 Restarting *${d.name}*...`, { parse_mode: "Markdown" });

  stopProject(d.id);
  await new Promise((r) => setTimeout(r, 1000));

  const result = await startProject(d.id, d.type, d.file_path, d.entry_file);
  let text: string;
  if (result.success && result.completed) {
    text = `✅ *${d.name}* ran successfully!\n\n\`\`\`\n${result.message.slice(0, 700)}\n\`\`\``;
  } else if (result.success) {
    text = `✅ *${d.name}* restarted!`;
    if (result.url) text += `\n🌐 URL: ${result.url}`;
    else if (result.port) text += `\n🔌 Port: \`${result.port}\``;
  } else {
    text = `❌ Restart failed:\n\`\`\`\n${result.message.slice(0, 700)}\n\`\`\``;
  }

  await ctx.editMessageText(text, { parse_mode: "Markdown", ...projectKeyboard(d.id) });
});

// ── Logs ──────────────────────────────────────────────────────────────────────
bot.action(/^action:logs:(.+)$/, async (ctx) => {
  const deployId = ctx.match[1];
  const userId = ctx.from!.id;
  const d = await getDeployment(deployId);
  if (!d || d.user_id !== userId) { await ctx.answerCbQuery("Not found."); return; }
  await ctx.answerCbQuery();

  const running = isRunning(d.id);
  const projectLogs = getLogs(d.id);
  const exitCode = getLastExitCode(d.id);

  if (projectLogs.length === 0) {
    // No logs at all — project was never started this session
    await ctx.reply(
      running
        ? `📋 *${d.name}* is running but has no output yet.\n\n_Check back in a moment._`
        : `📋 *${d.name}* hasn't been started yet.\n\nStart it first to see its output.`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          running
            ? [Markup.button.callback("🔄 Refresh", `action:logs:${d.id}`)]
            : [Markup.button.callback("▶️ Start Project", `action:start:${d.id}`)],
          [Markup.button.callback("⬅️ Back to Project", `action:info:${d.id}`)],
        ]),
      }
    );
    return;
  }

  const last = projectLogs.slice(-40);
  const logText = last.join("\n").slice(0, 3500);
  const lineNote = projectLogs.length > 40 ? `_Showing last 40 of ${projectLogs.length} lines_\n\n` : "";
  const statusNote = running
    ? `🟢 _Currently running_\n\n`
    : exitCode !== undefined && exitCode !== null
    ? `🔴 _Last run exited with code ${exitCode}_\n\n`
    : `🔴 _Stopped_\n\n`;

  await ctx.reply(
    `📋 *Logs: ${d.name}*\n\n${statusNote}${lineNote}\`\`\`\n${logText}\n\`\`\``,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        running
          ? [Markup.button.callback("🔄 Refresh Logs", `action:logs:${d.id}`)]
          : [Markup.button.callback("▶️ Start Again", `action:start:${d.id}`)],
        [Markup.button.callback("⬅️ Back to Project", `action:info:${d.id}`)],
      ]),
    }
  );
});

// ── Env Menu ──────────────────────────────────────────────────────────────────
bot.action(/^action:envmenu:(.+)$/, async (ctx) => {
  const deployId = ctx.match[1];
  const userId = ctx.from!.id;
  const d = await getDeployment(deployId);
  if (!d || d.user_id !== userId) { await ctx.answerCbQuery("Not found."); return; }
  await ctx.answerCbQuery();

  const envs = await getEnvs(d.id);
  let text = `🔑 *Environment Variables: ${d.name}*\n\n`;

  if (envs.length === 0) {
    text += "_No variables set yet._\n";
  } else {
    for (const { key, value } of envs) {
      text += `• \`${key}\` = \`${value}\`\n`;
    }
  }

  text += "\n_Changes take effect after restart._";

  await ctx.editMessageText(text, { parse_mode: "Markdown", ...envMenuKeyboard(d.id) });
});

// ── Add Env ───────────────────────────────────────────────────────────────────
bot.action(/^action:setenv:(.+)$/, async (ctx) => {
  const deployId = ctx.match[1];
  const userId = ctx.from!.id;
  const d = await getDeployment(deployId);
  if (!d || d.user_id !== userId) { await ctx.answerCbQuery("Not found."); return; }
  await ctx.answerCbQuery();

  setState(userId, { type: "awaiting_env", deployId });

  await ctx.editMessageText(
    `🔑 *Add Environment Variable*\n\nType the variable in this format:\n\n\`KEY=VALUE\`\n\nExample: \`PORT=3000\` or \`API_KEY=abc123\``,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("❌ Cancel", `action:envmenu:${deployId}`)],
      ]),
    }
  );
});

// ── Remove Env ────────────────────────────────────────────────────────────────
bot.action(/^action:removeenv:(.+)$/, async (ctx) => {
  const deployId = ctx.match[1];
  const userId = ctx.from!.id;
  const d = await getDeployment(deployId);
  if (!d || d.user_id !== userId) { await ctx.answerCbQuery("Not found."); return; }

  const envs = await getEnvs(d.id);
  if (envs.length === 0) {
    await ctx.answerCbQuery("No env vars to remove.");
    return;
  }

  await ctx.answerCbQuery();

  // Show buttons for each key to remove
  const buttons = envs.map(({ key }) => [
    Markup.button.callback(`🗑️ ${key}`, `action:doremoveenv:${deployId}:${key}`),
  ]);
  buttons.push([Markup.button.callback("❌ Cancel", `action:envmenu:${deployId}`)]);

  await ctx.editMessageText(
    `🗑️ *Remove Variable*\n\nSelect the variable to remove:`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) }
  );
});

bot.action(/^action:doremoveenv:([^:]+):(.+)$/, async (ctx) => {
  const deployId = ctx.match[1];
  const key = ctx.match[2];
  const userId = ctx.from!.id;
  const d = await getDeployment(deployId);
  if (!d || d.user_id !== userId) { await ctx.answerCbQuery("Not found."); return; }
  await ctx.answerCbQuery(`Removed ${key}`);

  await removeEnv(deployId, key);

  const envs = await getEnvs(deployId);
  let text = `🔑 *Environment Variables: ${d.name}*\n\n`;
  text += `✅ Removed \`${key}\`.\n\n`;

  if (envs.length === 0) {
    text += "_No variables set._";
  } else {
    for (const e of envs) text += `• \`${e.key}\` = \`${e.value}\`\n`;
  }

  await ctx.editMessageText(text, { parse_mode: "Markdown", ...envMenuKeyboard(deployId) });
});

// ── Delete Prompt ─────────────────────────────────────────────────────────────
bot.action(/^action:delete_prompt:(.+)$/, async (ctx) => {
  const deployId = ctx.match[1];
  const userId = ctx.from!.id;
  const d = await getDeployment(deployId);
  if (!d || d.user_id !== userId) { await ctx.answerCbQuery("Not found."); return; }
  await ctx.answerCbQuery();

  await ctx.editMessageText(
    `⚠️ *Delete "${d.name}"?*\n\nThis will stop the project and permanently delete all files and settings.\n\n_This cannot be undone._`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🗑️ Yes, Delete", `action:confirmdelete:${d.id}`)],
        [Markup.button.callback("❌ Cancel", `action:info:${d.id}`)],
      ]),
    }
  );
});

bot.action(/^action:confirmdelete:(.+)$/, async (ctx) => {
  const deployId = ctx.match[1];
  const userId = ctx.from!.id;
  const d = await getDeployment(deployId);
  if (!d || d.user_id !== userId) { await ctx.answerCbQuery("Not found."); return; }
  await ctx.answerCbQuery("Deleting...");

  stopProject(d.id);
  await deleteDeployment(d.id);
  try { fs.rmSync(d.file_path, { recursive: true, force: true }); } catch {}

  await ctx.editMessageText(
    `🗑️ *${d.name}* has been deleted.`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("📋 My Projects", "menu:list")],
        [Markup.button.callback("🏠 Main Menu", "menu:main")],
      ]),
    }
  );
});

// ── Auto-install & Retry ──────────────────────────────────────────────────────
bot.action(/^action:autoinstall:([^:]+):(.+)$/, async (ctx) => {
  const deployId = ctx.match[1];
  const modules = ctx.match[2].split(",").filter(Boolean);
  const userId = ctx.from!.id;
  const d = await getDeployment(deployId);
  if (!d || d.user_id !== userId) { await ctx.answerCbQuery("Not found."); return; }
  await ctx.answerCbQuery("Installing...");

  await ctx.editMessageText(
    `🔧 *Installing ${modules.join(", ")}...*\n\n_This may take a moment._`,
    { parse_mode: "Markdown" }
  );

  const { success, output } = await installPythonPackages(modules);

  if (!success) {
    await ctx.editMessageText(
      `❌ *Installation failed*\n\n\`\`\`\n${output.slice(0, 700)}\n\`\`\``,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("▶️ Retry Anyway", `action:start:${d.id}`)],
          [Markup.button.callback("⬅️ Back to Project", `action:info:${d.id}`)],
        ]),
      }
    );
    return;
  }

  await ctx.editMessageText(
    `✅ *Installed! Starting ${d.name}...*`,
    { parse_mode: "Markdown" }
  );

  const result = await startProject(d.id, d.type, d.file_path, d.entry_file);

  if (result.success && result.completed) {
    await ctx.editMessageText(
      `✅ *${d.name}* ran successfully!\n\n\`\`\`\n${result.message.slice(0, 800)}\n\`\`\``,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("▶️ Run Again", `action:start:${d.id}`)],
          [Markup.button.callback("📋 Logs", `action:logs:${d.id}`)],
          [Markup.button.callback("⬅️ Back to Project", `action:info:${d.id}`)],
        ]),
      }
    );
  } else if (result.success) {
    let text = `✅ *${d.name}* is running!`;
    if (result.url) text += `\n🌐 URL: ${result.url}`;
    await ctx.editMessageText(text, { parse_mode: "Markdown", ...projectKeyboard(d.id) });
  } else {
    const buttons: ReturnType<typeof Markup.button.callback>[][] = [];
    if (result.missingModules && result.missingModules.length > 0) {
      buttons.push([
        Markup.button.callback(
          `🔧 Auto-install "${result.missingModules.join(", ")}" & Retry`,
          `action:autoinstall:${d.id}:${result.missingModules.join(",")}`
        ),
      ]);
    }
    buttons.push([Markup.button.callback("▶️ Retry", `action:start:${d.id}`)]);
    buttons.push([Markup.button.callback("⬅️ Back to Project", `action:info:${d.id}`)]);
    await ctx.editMessageText(
      `❌ *${d.name}* still crashed\n\n\`\`\`\n${result.message.slice(0, 800)}\n\`\`\``,
      { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) }
    );
  }
});

// ── Send Command (stdin) ──────────────────────────────────────────────────────
bot.action(/^action:cmd:(.+)$/, async (ctx) => {
  const deployId = ctx.match[1];
  const userId = ctx.from!.id;
  const d = await getDeployment(deployId);
  if (!d || d.user_id !== userId) { await ctx.answerCbQuery("Not found."); return; }

  if (!isRunning(d.id)) {
    await ctx.answerCbQuery("Project is not running.");
    return;
  }

  await ctx.answerCbQuery();
  setState(userId, { type: "awaiting_command", deployId });

  await ctx.reply(
    `⌨️ *Send Command to "${d.name}"*\n\nType the command or text to send to the running process:`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("❌ Cancel", `action:info:${deployId}`)],
      ]),
    }
  );
});

// ── Error handler ─────────────────────────────────────────────────────────────
bot.catch((err: unknown, ctx: Context) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Bot error [${ctx.updateType}]:`, msg);
  ctx.reply("❌ Something went wrong. Please try again.", mainMenuKeyboard()).catch(() => {});
});

// ── Launch ────────────────────────────────────────────────────────────────────
async function main() {
  await initDb();
  await resetAllRunningToStopped();
  console.log("✅ Database initialized.");

  await bot.launch();
  console.log("🚀 HostBot is running!");

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
