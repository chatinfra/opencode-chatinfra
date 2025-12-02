import { tool } from "@opencode-ai/plugin";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import fs from "fs";

// Ensure local .env is loaded even if the host process doesn't preload env vars
try {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const rootDir = resolve(__dirname, "..");
  dotenv.config({ path: resolve(rootDir, ".env") });
} catch {
  // Best-effort: ignore if unavailable in this runtime
}

/**
 * XmppNotifyPlugin
 *
 * Exposes a `xmpp_send` tool to send an XMPP message to a JID.
 * Credentials and connection details are taken from environment variables:
 * - XMPP_JID: full JID to authenticate (e.g., user@example.com)
 * - XMPP_PASS: account password
 * - XMPP_SERVICE: WebSocket or TCP URL (e.g., wss://example.com/xmpp-websocket or xmpp://example.com:5222)
 *   If not provided, the plugin will attempt to construct it from XMPP_HOST and XMPP_PORT.
 * - XMPP_HOST (optional): hostname, used if XMPP_SERVICE is not set
 * - XMPP_PORT (optional): port, defaults to 5222 when not set
 * - XMPP_RESOURCE (optional): resource string
 */
export async function XmppNotifyPlugin(_ctx) {
  return {
    tool: {
      xmpp_send: tool({
        description: "Send an XMPP message to a JID using environment credentials.",
        // Build schema from the loader-provided Zod instance to ensure compatibility
        args: (z) =>
          z.object({
            account: z
              .string()
              .describe(
                "Optional account key to select credentials from env, e.g. 'JP' -> XMPP_JID_JP & XMPP_PASS_JP. If omitted, uses XMPP_JID & XMPP_PASS."
              )
              .optional(),
            to: z.string().describe("Recipient JID (e.g., someone@example.com)"),
            message: z.string().describe("Message body to send"),
            // subject: z.string().describe("Optional subject").optional(),
          }),
        async execute(args, _toolCtx) {
          const { XMPP_SERVICE, XMPP_HOST, XMPP_PORT, XMPP_RESOURCE } =
            process.env;
          const { XMPP_DEBUG, XMPP_DEBUG_FILE } = process.env;

          // Discover available account suffixes from env
          const env = process.env;
          const accounts = new Map(); // KEY -> { jid, password }
          for (const key of Object.keys(env)) {
            const m = key.match(/^XMPP_JID_(.+)$/);
            if (m) {
              const suffix = m[1];
              const pw = env[`XMPP_PASS_${suffix}`];
              if (pw) {
                accounts.set(suffix, { jid: env[key], password: pw });
              }
            }
          }

          // Normalize account key from args
          const normalize = (s) =>
            s
              .trim()
              .replace(/[^a-zA-Z0-9]+/g, "_")
              .toUpperCase();

          let selectedCreds;
          let selectedKey = null;
          if (args.account) {
            const key = normalize(String(args.account));
            selectedKey = key;
            if (accounts.has(key)) {
              selectedCreds = accounts.get(key);
            } else {
              const available = Array.from(accounts.keys()).sort();
              return available.length
                ? `No credentials found for account '${args.account}' (normalized '${key}'). Available accounts: ${available.join(", ")}. Define env XMPP_JID_${key} and XMPP_PASS_${key}.`
                : `No multi-account credentials found for account '${args.account}' (normalized '${key}'). Define env XMPP_JID_${key} and XMPP_PASS_${key}, or set global XMPP_JID and XMPP_PASS.`;
            }
          } else {
            // Fallback to global vars if present
            if (env.XMPP_JID && env.XMPP_PASS) {
              selectedCreds = { jid: env.XMPP_JID, password: env.XMPP_PASS };
            } else if (accounts.size === 1) {
              // If only one account is available, use it implicitly
              const [onlyKey, creds] = Array.from(accounts.entries())[0];
              selectedKey = onlyKey;
              selectedCreds = creds;
            } else if (accounts.size > 1) {
              const available = Array.from(accounts.keys()).sort();
              return `Multiple XMPP accounts are configured (${available.join(
                ", "
              )}), but no 'account' argument was provided and global XMPP_JID/XMPP_PASS are not set. Provide 'account', e.g., account: ${available[0]}.`;
            } else {
              return "XMPP_JID and XMPP_PASS are not set in environment. Set global creds or use account-specific XMPP_JID_<KEY> and XMPP_PASS_<KEY>.";
            }
          }

          let service = XMPP_SERVICE;
          if (!service) {
            const host = XMPP_HOST || "localhost";
            const port = XMPP_PORT || "5222";
            service = `xmpp://${host}:${port}`;
          }

          // Lazy import to avoid adding weight unless used
          let clientModule;
          try {
            clientModule = await import("@xmpp/client");
          } catch (err) {
            return `@xmpp/client is not installed. Add it to dependencies (e.g., npm i @xmpp/client). Error: ${String(
              err
            )}`;
          }

          const { client, xml } = clientModule;
          const xmpp = client({
            service,
            domain: selectedCreds.jid.split("@")[1],
            resource: XMPP_RESOURCE,
            username: selectedCreds.jid.split("@")[0],
            password: selectedCreds.password,
          });

          // Optional debug logging (accept common truthy values: 1, true, yes, on)
          const debugEnabled = ["1", "true", "yes", "on"].includes(
            String(XMPP_DEBUG || "").trim().toLowerCase()
          );
          let debugStream = null;
          let logFile = (XMPP_DEBUG_FILE || "").trim();
          if (!logFile) logFile = "/tmp/xmpp-debug.log";
          const writeLog = (line) => {
            if (!debugEnabled) return;
            try {
              const ts = new Date().toISOString();
              if (debugStream) debugStream.write(`${ts} ${line}\n`);
            } catch {}
          };
          if (debugEnabled) {
            try {
              fs.mkdirSync(dirname(logFile), { recursive: true });
              debugStream = fs.createWriteStream(logFile, { flags: "a" });
              const banner = `--- xmpp_send debug enabled pid=${process.pid} service=${service} jid=${selectedCreds.jid} ---`;
              writeLog(banner);
              // Log submitted parameters for traceability
              try {
                // Avoid logging functions or complex objects; args is expected to be plain
                const safeArgs = {
                  account: args.account ?? null,
                  to: args.to,
                  message: args.message,
                };
                writeLog(`args: ${JSON.stringify(safeArgs)}`);
              } catch {}
              // Hook common events
              xmpp.on("status", (s) => writeLog(`status: ${s}`));
              xmpp.on("online", (addr) =>
                writeLog(`online: ${addr && addr.toString ? addr.toString() : String(addr)}`)
              );
              xmpp.on("stanza", (stanza) =>
                writeLog(`stanza: ${stanza && stanza.toString ? stanza.toString() : String(stanza)}`)
              );
              xmpp.on("error", (e) =>
                writeLog(`error: ${e && e.stack ? e.stack : String(e)}`)
              );
            } catch (e) {
              // If we cannot open the log file, disable debug to avoid throwing
            }
          }

          // ---- Runtime validation (host may not enforce Zod at runtime) ----
          const rawTo = args?.to;
          const rawBody = args?.message;
          const isBlank = (v) => v == null || (typeof v === "string" && v.trim() === "");
          if (isBlank(rawTo)) {
            return "Missing required argument 'to' (recipient JID). Example: to=someone@example.com";
          }
          if (rawBody == null) {
            return "Missing required argument 'message'. Provide a non-empty message body.";
          }

          // Normalize recipient JID (strip resource by default to avoid ephemeral session targeting)
          const truthy = (s) => ["1", "true", "yes", "on"].includes(String(s || "").trim().toLowerCase());
          const falsy = (s) => ["0", "false", "no", "off"].includes(String(s || "").trim().toLowerCase());
          const stripResourceEnv = process.env.XMPP_TO_STRIP_RESOURCE;
          // default true unless explicitly falsey
          const stripResource = stripResourceEnv === undefined ? true : truthy(stripResourceEnv) && !falsy(stripResourceEnv) || (!truthy(stripResourceEnv) && !falsy(stripResourceEnv) ? true : truthy(stripResourceEnv));
          let toOriginal = String(rawTo);
          let toNormalized = toOriginal;
          let resourceStripped = false;
          if (toOriginal.includes("/")) {
            const bare = toOriginal.split("/")[0];
            if (stripResource) {
              toNormalized = bare;
              resourceStripped = true;
            }
          }

          const to = toNormalized;
          const body = typeof rawBody === "string" ? rawBody : String(rawBody);
//          const subject = args.subject;

          const result = {
            connected: false,
            sent: false,
            errors: [],
          };

          const waitFor = (emitter, event, rejectOnError = false) =>
            new Promise((resolve, reject) => {
              const onResolve = (...v) => {
                cleanup();
                resolve(v);
              };
              const onError = (e) => {
                cleanup();
                if (rejectOnError) reject(e);
                else resolve([e]);
              };
              const cleanup = () => {
                emitter.removeListener(event, onResolve);
                emitter.removeListener("error", onError);
              };
              emitter.once(event, onResolve);
              emitter.once("error", onError);
            });

          try {
            // establish connection
            const onlineP = waitFor(xmpp, "online", true);
            await xmpp.start();
            await onlineP;
            result.connected = true;

            // Log normalization details after debug stream is available
            writeLog(
              `to_normalized: from=${toOriginal} to=${to} stripped=${resourceStripped}`
            );

            // Send initial presence to establish availability
            try {
              await xmpp.send(xml("presence"));
              writeLog("presence: sent");
            } catch (e) {
              writeLog(`presence: failed ${e && e.message ? e.message : String(e)}`);
            }

            // compose message stanza
            const children = [];
//            if (subject) {
//              children.push(xml("subject", {}, subject));
//            }
            children.push(xml("body", {}, body));
            const messageStanza = xml(
              "message",
              { type: "chat", to },
              ...children
            );

            // Debug: log intent to send and the exact stanza
            writeLog(
              `send: to=${to} body_len=${typeof body === "string" ? body.length : 0}`
            );
            try {
              writeLog(`send: stanza ${messageStanza.toString()}`);
            } catch {}

            // Observe potential error stanzas for our send window
            let lastErrorStanza = null;
            const stanzaHandler = (stanza) => {
              try {
                if (stanza?.is && stanza.is("message") && stanza.attrs?.type === "error") {
                  const errorEl = stanza.getChild("error");
                  const textEl = errorEl ? errorEl.getChild("text") : null;
                  const typeAttr = errorEl ? errorEl.attrs?.type : undefined;
                  const textStr = textEl ? textEl.text() : undefined;
                  lastErrorStanza = { type: typeAttr, text: textStr, xml: stanza.toString() };
                  writeLog(
                    `send:error-stanza type=${typeAttr || ""} text=${textStr || ""} xml=${stanza.toString()}`
                  );
                }
              } catch {}
            };
            xmpp.on("stanza", stanzaHandler);

            await xmpp.send(messageStanza);
            result.sent = true;

            writeLog("send: ok");

            // Optional post-send delay to avoid closing before routing completes
            // Controlled by env XMPP_POST_SEND_DELAY_MS (default 500ms)
            const delayMsRaw = (process.env.XMPP_POST_SEND_DELAY_MS || "").trim();
            const delayMs = Number.isFinite(Number(delayMsRaw)) && delayMsRaw !== ""
              ? Math.max(0, parseInt(delayMsRaw, 10))
              : 500;
            if (delayMs > 0) {
              writeLog(`post-send: delaying close by ${delayMs}ms`);
              await new Promise((r) => setTimeout(r, delayMs));
            }

            // Graceful stop
            try {
              await xmpp.stop();
            } catch {}
            try {
              xmpp.removeListener("stanza", stanzaHandler);
            } catch {}
            if (debugStream) {
              try {
                debugStream.end();
              } catch {}
            }

            const acctInfo = selectedKey ? ` using account ${selectedKey}` : "";
            if (lastErrorStanza) {
              return `XMPP message sent to ${to}${acctInfo}, but server replied with error: ${lastErrorStanza.type || ""} ${lastErrorStanza.text || ""}`.trim();
            }
            return `XMPP message sent to ${to}${acctInfo}.`;
          } catch (err) {
            result.errors.push(String(err));
            try {
              await xmpp.stop();
            } catch {}
            if (debugStream) {
              try {
                debugStream.end();
              } catch {}
            }
            const acctInfo = selectedKey ? ` (account ${selectedKey})` : "";
            return `Failed to send XMPP message${acctInfo}: ${result.errors.join(
              "; "
            )}`;
          }
        },
      }),
    },
  };
}
