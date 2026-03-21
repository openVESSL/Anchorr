import crypto from "crypto";
import logger from "./logger.js";
import { readConfig, updateConfig } from "./configFile.js";

// Generate or retrieve WEBHOOK_SECRET
function getOrGenerateWebhookSecret() {
  const config = readConfig();
  if (config?.WEBHOOK_SECRET && config.WEBHOOK_SECRET.trim() !== "") {
    return config.WEBHOOK_SECRET;
  }

  if (process.env.WEBHOOK_SECRET) {
    return process.env.WEBHOOK_SECRET;
  }

  logger.warn("WEBHOOK_SECRET not found in config. Generating a new secure secret...");
  const newSecret = crypto.randomBytes(32).toString("hex");

  if (updateConfig({ WEBHOOK_SECRET: newSecret })) {
    logger.info("✅ WEBHOOK_SECRET generated and saved to config.json successfully");
    process.env.WEBHOOK_SECRET = newSecret;
  } else {
    logger.error("❌ Failed to save WEBHOOK_SECRET to config");
    logger.warn("⚠️  Using in-memory WEBHOOK_SECRET - it will change on restart");
  }

  return newSecret;
}

export const WEBHOOK_SECRET = getOrGenerateWebhookSecret();
