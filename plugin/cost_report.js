import { tool } from "@opencode-ai/plugin/tool";

/**
 * CostReportPlugin
 *
 * Exposes a `cost_report` tool that scans all sessions
 * for the current directory, aggregates assistant message
 * costs per provider/model for "today" (local time), and
 * returns a human-readable text report.
 *
 * This file is plain ESM JavaScript so it can be loaded
 * directly by Opencode without a build step.
 */
export async function CostReportPlugin(ctx) {
  const { client, directory } = ctx;

  return {
    tool: {
      cost_report: tool({
        description:
          "Generate a cost report for today across all API providers and models.",
        // No arguments needed; provide a factory so the loader injects its Zod instance
        args: (z) => z.object({}),
        async execute(_args, _toolCtx) {
          // Determine today's local start/end in ms
          const now = new Date();
          const startOfDay = new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate()
          );
          const startMs = startOfDay.getTime();
          const endMs = startMs + 24 * 60 * 60 * 1000;

          // Load provider metadata (names, models, etc.)
          let providerMeta;
          try {
            providerMeta = await client.provider.list({
              query: { directory },
              responseStyle: "data",
            });
          } catch {
            // Fallback: try config.providers if provider.list is unavailable
            try {
              const configProviders = await client.config.providers({
                query: { directory },
                responseStyle: "data",
              });
              providerMeta = {
                all: configProviders.providers,
                default: configProviders.default,
                connected: [],
              };
            } catch {
              providerMeta = { all: [], default: {}, connected: [] };
            }
          }

          const providersById = new Map();
          if (providerMeta && Array.isArray(providerMeta.all)) {
            for (const p of providerMeta.all) {
              providersById.set(p.id, p);
            }
          }

          // Aggregate cost per provider/model
          const statsByProvider = new Map();

          // Fetch sessions:
          // - Prefer sessions for the current directory
          // - Also attempt to include any additional sessions (no directory filter)
          let sessions = [];
          try {
            const byDirectory = await client.session.list({
              query: { directory },
              responseStyle: "data",
            });
            if (Array.isArray(byDirectory)) {
              sessions = byDirectory;
            }

            try {
              const allSessions = await client.session.list({
                responseStyle: "data",
              });
              if (Array.isArray(allSessions)) {
                const seen = new Set(sessions.map((s) => s.id));
                for (const s of allSessions) {
                  if (!seen.has(s.id)) {
                    sessions.push(s);
                    seen.add(s.id);
                  }
                }
              }
            } catch {
              // ignore, directory-scoped sessions are still useful
            }
          } catch {
            // Fallback: try without directory at all
            try {
              const allSessions = await client.session.list({
                responseStyle: "data",
              });
              if (Array.isArray(allSessions)) {
                sessions = allSessions;
              }
            } catch {
              return "Unable to load sessions to compute cost report.";
            }
          }

          for (const session of sessions) {
            let messages = [];
            try {
              messages = await client.session.messages({
                path: { id: session.id },
                query: {
                  directory,
                  // Limit per session; adjust if you routinely exceed this
                  limit: 1000,
                },
                responseStyle: "data",
              });
            } catch {
              continue;
            }

            for (const entry of messages) {
              const info = entry?.info;
              if (!info || info.role !== "assistant") continue;

              const created = info.time?.created;
              if (
                typeof created !== "number" ||
                created < startMs ||
                created >= endMs
              ) {
                continue;
              }

              const providerID = info.providerID || info.model?.providerID;
              const modelID = info.modelID || info.model?.modelID || "unknown";
              if (!providerID) continue;

              const cost =
                typeof info.cost === "number" && Number.isFinite(info.cost)
                  ? info.cost
                  : 0;

              const tokens = info.tokens || {
                input: 0,
                output: 0,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              };

              let providerStats = statsByProvider.get(providerID);
              if (!providerStats) {
                const provider = providersById.get(providerID);
                providerStats = {
                  providerID,
                  providerName: provider?.name || providerID,
                  totalCost: 0,
                  totalMessages: 0,
                  totalTokensInput: 0,
                  totalTokensOutput: 0,
                  totalTokensReasoning: 0,
                  models: new Map(),
                };
                statsByProvider.set(providerID, providerStats);
              }

              providerStats.totalCost += cost;
              providerStats.totalMessages += 1;
              providerStats.totalTokensInput += tokens.input || 0;
              providerStats.totalTokensOutput += tokens.output || 0;
              providerStats.totalTokensReasoning += tokens.reasoning || 0;

              let modelStats = providerStats.models.get(modelID);
              if (!modelStats) {
                const provider = providersById.get(providerID);
                const modelMeta = provider?.models?.[modelID];
                modelStats = {
                  modelID,
                  modelName: modelMeta?.name || modelID,
                  cost: 0,
                  messages: 0,
                  tokensInput: 0,
                  tokensOutput: 0,
                  tokensReasoning: 0,
                };
                providerStats.models.set(modelID, modelStats);
              }

              modelStats.cost += cost;
              modelStats.messages += 1;
              modelStats.tokensInput += tokens.input || 0;
              modelStats.tokensOutput += tokens.output || 0;
              modelStats.tokensReasoning += tokens.reasoning || 0;
            }
          }

          if (statsByProvider.size === 0) {
            const formatter = new Intl.DateTimeFormat(undefined, {
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
            });
            const dayLabel = formatter.format(startOfDay);
            return `No assistant usage recorded for today (${dayLabel}).`;
          }

          // Build human-readable report
          const lines = [];
          const formatter = new Intl.DateTimeFormat(undefined, {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          });
          const dayLabel = formatter.format(startOfDay);

          lines.push(`Cost report for ${dayLabel}`);
          lines.push("");

          let grandTotal = 0;

          for (const providerStats of statsByProvider.values()) {
            grandTotal += providerStats.totalCost;
          }

          lines.push(`Total cost (all providers): $${grandTotal.toFixed(4)}`);
          lines.push("");

          for (const providerStats of statsByProvider.values()) {
            lines.push(
              `Provider: ${providerStats.providerName} (${providerStats.providerID})`
            );
            lines.push(
              `  Total cost: $${providerStats.totalCost.toFixed(
                4
              )} over ${providerStats.totalMessages} messages`
            );
            lines.push(
              `  Tokens: input=${providerStats.totalTokensInput}, output=${providerStats.totalTokensOutput}, reasoning=${providerStats.totalTokensReasoning}`
            );

            // Per-model breakdown
            if (providerStats.models.size > 0) {
              lines.push("  Models:");
              for (const modelStats of providerStats.models.values()) {
                lines.push(
                  `    - ${modelStats.modelName} (${modelStats.modelID}): ` +
                    `$${modelStats.cost.toFixed(4)} over ${modelStats.messages} messages ` +
                    `(in=${modelStats.tokensInput}, out=${modelStats.tokensOutput}, reasoning=${modelStats.tokensReasoning})`
                );
              }
            }

            lines.push(""); // blank line between providers
          }

          return lines.join("\n");
        },
      }),
    },
  };
}

export default CostReportPlugin;
