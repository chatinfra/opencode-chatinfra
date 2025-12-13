import { z, z as zodSchema } from "zod";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

let cachedTool;
const acquireTool = async () => {
  if (cachedTool) return cachedTool;
  try {
    const module = await import("@opencode-ai/plugin");
    cachedTool = module.tool;
  } catch {
    const fallback = (input) => input;
    fallback.schema = zodSchema;
    cachedTool = fallback;
  }
  return cachedTool;
};

const getOpencodeLogger = () => {
  if (typeof globalThis !== "undefined") {
    if (globalThis.opencodeLogger) {
      return globalThis.opencodeLogger;
    }
    if (globalThis.logger) {
      return globalThis.logger;
    }
  }
  return console;
};

const logToOpencode = (level, message) => {
  const logger = getOpencodeLogger();
  const target =
    (logger && typeof logger[level] === "function" && logger[level]) ||
    (logger && typeof logger.log === "function" && logger.log) ||
    console.log;
  try {
    const ret = target.call(logger, `[chatinfra] ${message}`);
    if (ret && typeof ret.then === "function") {
      Promise.resolve(ret).catch(() => {});
    }
  } catch {}
};

const logInfo = (message) => logToOpencode("info", message);
const logError = (message) => logToOpencode("error", message);

try {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  dotenv.config({ path: resolve(__dirname, "..", ".env") });
} catch {
  // Best-effort; ignore if env loading is not available in this runtime.
}

const normalizeTimeout = (value, fallback) => {
  const num = parseInt(String(value ?? ""), 10);
  return Number.isFinite(num) && num > 0 ? num : fallback;
};

const safeJson = (value, maxLength = 1000) => {
  if (value == null) return "";
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;
  } catch {
    return String(value);
  }
};

const normalizeToolOutput = (value) => {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return safeJson(value, 10000);
};

const BASE_URL = process.env.CHATINFRA_API_BASE_URL || "https://api.example.com";
const AUTH_TOKEN = process.env.CHATINFRA_API_KEY || process.env.CHATINFRA_API_TOKEN || "";
const TIMEOUT_MS = normalizeTimeout(process.env.CHATINFRA_API_TIMEOUT_MS, 15000);

const buildUrl = (path, query) => {
  const url = new URL(BASE_URL + path);

  logInfo(`buildUrl Using Chatinfra API base URL: ${BASE_URL}`);

  if (query) {
    Object.entries(query).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      url.searchParams.set(key, String(value));
    });
  }
  logInfo(`buildUrl returning: ${url}`);

  return url;
};

const callApi = async (toolName, { method, path, query, body }) => {
  if (typeof fetch !== "function") {
    throw new Error("Fetch API is not available in this runtime.");
  }

  const url = buildUrl(path, query);
  const headers = {
    Accept: "application/json",
  };
  const hasBody = body !== undefined;
  if (hasBody) {
    headers["Content-Type"] = "application/json";
  }
  if (AUTH_TOKEN) {
    headers["Authorization"] = `Bearer ${AUTH_TOKEN}`;
  }

  const options = {
    method,
    headers,
  };
  if (hasBody) {
    options.body = JSON.stringify(body ?? null);
  }

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  if (controller && TIMEOUT_MS) {
    options.signal = controller.signal;
  }
  logInfo("BEFORE other log")
  logInfo(
    `[${toolName}] Request ${method} ${url.href} query=${safeJson(url.searchParams.toString())} body=${safeJson(body)} serializedBody=${safeJson(options.body)}`
  );

  let timeoutId;
  if (controller && TIMEOUT_MS) {
    timeoutId = setTimeout(() => {
      controller.abort();
    }, TIMEOUT_MS);
  }

  try {
    const response = await fetch(url.href, options);
    const payload = await response.text();

    let parsed = null;
    try {
      parsed = payload ? JSON.parse(payload) : null;
    } catch {
      parsed = null;
    }

    logInfo(
      `[${toolName}] Response ${response.status} ${response.statusText} body=${safeJson(payload)}`
    );

    if (!response.ok) {
      const message =
        parsed?.message || parsed?.error || `${response.status} ${response.statusText}`;
      throw new Error(message);
    }

    logInfo("AFTER response.ok")
    logInfo(`[${toolName}] parsed: ${parsed}`)
    logInfo(`[${toolName}] payload: ${payload}`)
    return parsed ?? payload;
  } catch (err) {
    if (err.name === "AbortError") {
      logError(`[${toolName}] Request aborted after ${TIMEOUT_MS}ms`);
      throw new Error(`Request timed out after ${TIMEOUT_MS}ms`);
    }
    logError(`[${toolName}] ${err && err.stack ? err.stack : err}`);
    throw err;
  } finally {
    logInfo("in finally")
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    logInfo("after clearTimeout")
  }
  logInfo("AFTER other all")
};

export async function ChatinfraPlugin() {
  const toolFactory = await acquireTool();
  return {
    tool: {
       sendXmppMessage: toolFactory({
         description: "Send an XMPP stanza using the configured credentials.",
         args: {
           to: z.string().min(1).describe("Recipient JID, e.g. someone@example.com"),
           message: z.string().min(1).describe("Chat body for the message"),
         },
         async execute(args, _context) {
          const result = await callApi("sendXmppMessage", {
            method: "POST",
            path: "/xmpp/send",
            body: {
              to: args.to,
              message: args.message,
            },
          });
          return normalizeToolOutput(result);
        },
      }),
      describeXmppConnection: toolFactory({
        description: "Describe the configured XMPP credential.",
        args: (z) => z.object({}).optional().default({}).describe("No arguments required."),
        async execute() {
          const r = await callApi("describeXmppConnection", {
            method: "GET",
            path: "/xmpp/me",
          });
          logInfo(`describeXmppConnection: ${safeJson()}`);
          logInfo(`describeXmppConnection: ${safeJson(r)}`);
          return normalizeToolOutput(r);
        },
      }),
      scheduleTask: toolFactory({
        description: "Schedule a future send task.",
        args: (z) =>
          z.object({
            to: z
              .string()
              .min(1)
              .describe("Recipient JID for the scheduled message"),
            message: z
              .string()
              .min(1)
              .describe("Chat body to deliver when the task runs"),
            runAt: z
              .string()
              .optional()
              .describe("Optional ISO-8601 UTC time when the task should run"),
            intervalSeconds: z
              .number()
              .int()
              .positive()
              .optional()
              .describe("Optional recurrence interval in seconds"),
            metadata: z
              .record(z.string())
              .optional()
              .describe("Optional key-value metadata the scheduler stores"),
          }),
        async execute(args) {
          const payload = {
            to: args.to,
            message: args.message,
          };
          if (args.runAt) payload.runAt = args.runAt;
          if (args.intervalSeconds) payload.intervalSeconds = args.intervalSeconds;
          if (args.metadata) payload.metadata = args.metadata;

          const result = await callApi("scheduleTask", {
            method: "POST",
            path: "/tasks",
            body: payload,
          });
          return normalizeToolOutput(result);
        },
      }),
      listScheduledTasks: toolFactory({
        description: "List pending or active tasks, optionally filtered by status.",
        args: (z) =>
          z.object({
            status: z
              .string()
              .optional()
              .describe("Optional lifecycle status to filter (pending, running, etc.)"),
          }),
        async execute(args) {
          const result = await callApi("listScheduledTasks", {
            method: "GET",
            path: "/tasks",
            query: args.status ? { status: args.status } : undefined,
          });
          return normalizeToolOutput(result);
        },
      }),
      cancelScheduledTask: toolFactory({
        description: "Cancel a scheduled task by ID.",
        args: (z) =>
          z.object({
            taskId: z
              .string()
              .min(1)
              .describe("Identifier returned when the task was created"),
          }),
        async execute(args) {
          const result = await callApi("cancelScheduledTask", {
            method: "POST",
            path: `/tasks/${encodeURIComponent(args.taskId)}/cancel`,
          });
          return normalizeToolOutput(result);
        },
      }),
      getTaskHistory: toolFactory({
        description: "Retrieve recent task execution history.",
        args: (z) =>
          z.object({
            limit: z
              .number()
              .int()
              .positive()
              .max(100)
              .optional()
              .describe("Maximum history entries to return"),
            status: z
              .string()
              .optional()
              .describe("Optional final status filter (completed, failed, canceled)"),
          }),
        async execute(args) {
          const query = {};
          if (args.limit) query.limit = args.limit;
          if (args.status) query.status = args.status;
          const result = await callApi("getTaskHistory", {
            method: "GET",
            path: "/tasks/history",
            query: Object.keys(query).length ? query : undefined,
          });
          return normalizeToolOutput(result);
        },
      }),
    },
  };
}
