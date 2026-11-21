import { Router } from "express";
import fs from "fs";
import path from "path";
import { authenticateToken } from "../utils/auth.js";
import logger from "../utils/logger.js";

const router = Router();

function parseLogFile(filePath, limit = 1000) {
  try {
    if (!fs.existsSync(filePath)) {
      return { entries: [], truncated: false };
    }
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((line) => line.trim());

    const truncated = lines.length > limit;
    const relevantLines = lines.slice(-limit);

    const entries = relevantLines.map((line) => {
      try {
        const logEntry = JSON.parse(line);
        return {
          timestamp: logEntry.timestamp || "N/A",
          level: logEntry.level || "unknown",
          message: logEntry.message || "",
        };
      } catch {
        const match = line.match(
          /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+(\w+):\s+(.+)$/
        );
        if (match) {
          return {
            timestamp: match[1],
            level: match[2],
            message: match[3],
          };
        }
        return {
          timestamp: "N/A",
          level: "unknown",
          message: line,
        };
      }
    });

    return { entries, truncated };
  } catch (error) {
    logger.error("Error parsing log file:", error);
    return { entries: [], truncated: false };
  }
}

// The newest daily file of each log (logger.js rotates them as <prefix>-<date>.log)
const LOG_PREFIXES = { error: "error", all: "combined" };

router.get("/logs/:kind", authenticateToken, (req, res) => {
  const prefix = Object.hasOwn(LOG_PREFIXES, req.params.kind) ? LOG_PREFIXES[req.params.kind] : null;
  if (!prefix) return res.status(404).json({ success: false, message: "Unknown log" });
  const logsDir = path.join(process.cwd(), "logs");
  let logPath = path.join(logsDir, `${prefix}.log`);

  try {
    const files = fs.readdirSync(logsDir).filter((f) => f.startsWith(`${prefix}-`) && f.endsWith(".log"));
    if (files.length > 0) logPath = path.join(logsDir, files.sort().at(-1));
  } catch (e) {
    logger.warn(`Failed to enumerate log directory for ${req.params.kind} logs: ${e.message} — using default path`);
  }

  const { entries, truncated } = parseLogFile(logPath);
  res.json({
    file: path.basename(logPath),
    count: entries.length,
    total: truncated ? "1000+" : entries.length,
    truncated,
    entries,
  });
});

export default router;
