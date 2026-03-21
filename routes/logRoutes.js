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

router.get("/logs/error", authenticateToken, (req, res) => {
  const logsDir = path.join(process.cwd(), "logs");
  let errorLogPath = path.join(logsDir, "error.log");

  try {
    const files = fs.readdirSync(logsDir);
    const errorFiles = files.filter(
      (f) => f.startsWith("error-") && f.endsWith(".log")
    );
    if (errorFiles.length > 0) {
      errorFiles.sort().reverse();
      errorLogPath = path.join(logsDir, errorFiles[0]);
    }
  } catch (e) {
    // Fallback to default path
  }

  const { entries, truncated } = parseLogFile(errorLogPath);
  res.json({
    file: path.basename(errorLogPath),
    count: entries.length,
    total: truncated ? "1000+" : entries.length,
    truncated,
    entries,
  });
});

router.get("/logs/all", authenticateToken, (req, res) => {
  const logsDir = path.join(process.cwd(), "logs");
  let combinedLogPath = path.join(logsDir, "combined.log");

  try {
    const files = fs.readdirSync(logsDir);
    const combinedFiles = files.filter(
      (f) => f.startsWith("combined-") && f.endsWith(".log")
    );
    if (combinedFiles.length > 0) {
      combinedFiles.sort().reverse();
      combinedLogPath = path.join(logsDir, combinedFiles[0]);
    }
  } catch (e) {
    // Fallback to default path
  }

  const { entries, truncated } = parseLogFile(combinedLogPath);
  res.json({
    file: path.basename(combinedLogPath),
    count: entries.length,
    total: truncated ? "1000+" : entries.length,
    truncated,
    entries,
  });
});

export default router;
