/**
 * Centralized Winston Logger
 * Provides structured logging with levels, timestamps, and file rotation
 */

import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import path from "path";
import fs from "fs";

// Create logs directory if it doesn't exist
const logsDir = path.join(process.cwd(), "logs");
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Define log levels
const levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
};

// Define level colors for console output
const colors = {
  error: "red",
  warn: "yellow",
  info: "green",
  http: "magenta",
  debug: "blue",
};

winston.addColors(colors);

// Determine log level from environment or default to info
const level = () => {
  const env = process.env.DEBUG || "false";
  return env === "true" ? "debug" : "info";
};

// Define log format
const format = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

// Define console format (more readable)
const consoleFormat = winston.format.combine(
  winston.format.colorize({ all: true }),
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.printf(
    (info) =>
      `${info.timestamp} ${info.level}: ${info.message}${
        info.stack ? "\n" + info.stack : ""
      }`
  )
);

// Define transports
const transports = [
  // Console output
  new winston.transports.Console({
    format: consoleFormat,
  }),

  // Error log file with daily rotation
  new DailyRotateFile({
    filename: path.join(logsDir, "error-%DATE%.log"),
    datePattern: "YYYY-MM-DD",
    maxSize: "20m",
    maxFiles: "14d",
    level: "error",
    format: format,
    compress: true, // gzip compression for old files
  }),

  // Combined log file with daily rotation
  new DailyRotateFile({
    filename: path.join(logsDir, "combined-%DATE%.log"),
    datePattern: "YYYY-MM-DD",
    maxSize: "20m",
    maxFiles: "14d",
    format: format,
    compress: true, // gzip compression for old files
  }),
];

// Create logger instance
const logger = winston.createLogger({
  level: level(),
  levels,
  format,
  transports,
  silent: process.env.NODE_ENV === "test",
  exitOnError: false,
});

// Helper methods for common patterns
logger.api = (method, endpoint, status, duration) => {
  logger.http(`${method} ${endpoint} ${status} ${duration}ms`);
};

logger.discord = (event, message) => {
  logger.info(`[Discord] ${event}: ${message}`);
};

logger.tmdb = (action, message) => {
  logger.debug(`[TMDB] ${action}: ${message}`);
};

logger.seerr = (action, message) => {
  logger.debug(`[Seerr] ${action}: ${message}`);
};

logger.jellyfin = (action, message) => {
  logger.debug(`[Jellyfin] ${action}: ${message}`);
};

logger.cache = (action, key, hit = null) => {
  const hitMsg = hit !== null ? (hit ? "HIT" : "MISS") : "";
  logger.debug(`[Cache] ${action}: ${key} ${hitMsg}`.trim());
};

export default logger;
