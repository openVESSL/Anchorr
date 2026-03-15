import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import logger from "./logger.js";
import {
  readConfig,
  updateConfig,
  getUsers,
  saveUser as saveUserToConfig,
} from "./configFile.js";

// Generate or retrieve JWT_SECRET
function getOrGenerateJwtSecret() {
  // ALWAYS try to load from config file first (most important)
  const config = readConfig();
  if (config?.JWT_SECRET && config.JWT_SECRET.trim() !== "") {
    return config.JWT_SECRET;
  }

  // Then check process.env
  if (process.env.JWT_SECRET) {
    return process.env.JWT_SECRET;
  }

  // Generate a new secure JWT secret only as last resort
  logger.warn(
    "JWT_SECRET not found in config. Generating a new secure secret..."
  );
  const newSecret = crypto.randomBytes(64).toString("hex");

  // Save the generated secret to config
  if (updateConfig({ JWT_SECRET: newSecret })) {
    logger.info(
      "✅ JWT_SECRET generated and saved to config.json successfully"
    );
    process.env.JWT_SECRET = newSecret;
  } else {
    logger.error("❌ Failed to save JWT_SECRET to config");
    logger.warn(
      "⚠️  Using in-memory JWT_SECRET - sessions will not persist across restarts"
    );
  }

  return newSecret;
}

// Initialize JWT_SECRET once at module load (CRITICAL: must be constant for token verification)
const JWT_SECRET = getOrGenerateJwtSecret();

// In-memory set of revoked token JTIs (cleared on restart, which also invalidates all tokens if secret rotates)
const revokedTokens = new Set();
// Maximum time (in ms) to keep a revoked token JTI in memory, to avoid unbounded TTLs
const MAX_REVOKE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function revokeToken(token) {
  try {
    // Verify token signature and standard claims before trusting its contents
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded || typeof decoded !== "object" || !decoded.jti) {
      return;
    }
    // Only handle tokens that have a valid expiration time
    if (typeof decoded.exp !== "number" || !Number.isFinite(decoded.exp)) {
      return;
    }
    const nowMs = Date.now();
    const ttlFromExpMs = decoded.exp * 1000 - nowMs;
    // Skip already-expired tokens
    if (ttlFromExpMs <= 0) {
      return;
    }
    const ttl = Math.min(ttlFromExpMs, MAX_REVOKE_TTL_MS);
    revokedTokens.add(decoded.jti);
    // Auto-cleanup: remove JTI after bounded TTL
    setTimeout(() => revokedTokens.delete(decoded.jti), ttl);
  } catch (_) {
    // Ignore invalid or unverifiable tokens; they cannot be revoked
  }
}

function isTokenRevoked(jti) {
  return revokedTokens.has(jti);
}

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

export const authenticateToken = (req, res, next) => {
  const token = req.cookies.auth_token;

  if (!token) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    // Reject tokens that predate JTI issuance — they cannot be revoked
    if (!user || typeof user !== "object" || !user.jti) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    if (isTokenRevoked(user.jti)) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    req.user = user;
    next();
  });
};

export const login = async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res
      .status(400)
      .json({ success: false, message: "Username and password are required" });
  }

  const users = getUsers();
  const user = users.find((u) => u.username === username);

  if (!user) {
    return res
      .status(401)
      .json({ success: false, message: "Invalid credentials" });
  }

  const validPassword = await bcrypt.compare(password, user.password);
  if (!validPassword) {
    return res
      .status(401)
      .json({ success: false, message: "Invalid credentials" });
  }

  const token = jwt.sign({ id: user.id, username: user.username, jti: crypto.randomUUID() }, JWT_SECRET, {
    expiresIn: "7d",
  });

  res.cookie("auth_token", token, {
    httpOnly: true,
    secure: req.secure || req.headers["x-forwarded-proto"] === "https",
    sameSite: "strict",
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  });

  res.json({
    success: true,
    message: "Logged in successfully",
    username: user.username,
  });
};

export const register = async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res
      .status(400)
      .json({ success: false, message: "Username and password are required" });
  }

  const users = getUsers();

  // For now, only allow registration if no users exist (Single User Mode / First Run)
  if (users.length > 0) {
    return res.status(403).json({
      success: false,
      message: "Registration is disabled. An admin account already exists.",
    });
  }

  const salt = await bcrypt.genSalt(12);
  const hashedPassword = await bcrypt.hash(password, salt);

  try {
    const newUser = saveUserToConfig(username, hashedPassword);

    // Auto-login after register
    const token = jwt.sign(
      { id: newUser.id, username: newUser.username, jti: crypto.randomUUID() },
      JWT_SECRET,
      { expiresIn: "24h" }
    );

    res.cookie("auth_token", token, {
      httpOnly: true,
      secure: req.secure || req.headers["x-forwarded-proto"] === "https",
      sameSite: "strict",
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    });

    res.json({
      success: true,
      message: "Account created successfully",
      username: newUser.username,
    });
  } catch (error) {
    logger.error("Error during user registration:", error);
    res.status(500).json({
      success: false,
      message: "Error creating account - check server logs",
    });
  }
};

export const logout = (req, res) => {
  const token = req.cookies.auth_token;
  if (token) {
    revokeToken(token);
  }
  res.clearCookie("auth_token");
  res.json({ success: true, message: "Logged out successfully" });
};

export const checkAuth = (req, res) => {
  const token = req.cookies.auth_token;
  if (!token) {
    // Check if any users exist to determine if we should show register or login
    const users = getUsers();
    return res.json({ isAuthenticated: false, hasUsers: users.length > 0 });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      const users = getUsers();
      return res.json({ isAuthenticated: false, hasUsers: users.length > 0 });
    }
    // Mirror authenticateToken: reject tokens without JTI or that have been revoked
    if (!user || typeof user !== "object" || !user.jti || isTokenRevoked(user.jti)) {
      const users = getUsers();
      return res.json({ isAuthenticated: false, hasUsers: users.length > 0 });
    }
    res.json({ isAuthenticated: true, user });
  });
};
