import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import logger from "./logger.js";
import { readConfig, updateConfig } from "./configFile.js";
import { getUsers, saveUser as saveUserToConfig } from "./userStore.js";
import { PersistentMap } from "./persistentMap.js";
import { settings } from "./settings.js";
import { signIn, signOut } from "../api/jellyfinAdmin.js";
import { isMokaMode, MOKA_ADMIN, mokaSignIn, mokaSignOut, mokaUrl } from "../api/moka.js";

const AUTH_TOKEN_EXPIRATION = "7d";
const AUTH_TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// --- BRUTE-FORCE PROTECTION ---
const MAX_FAILED_ATTEMPTS = 5;          // lock after this many consecutive failures
const LOCKOUT_DURATION_MS = 10 * 60 * 1000; // 10 min lockout
const BASE_DELAY_MS = 300;              // progressive delay per failure: attempt * 300ms
const MAX_DELAY_MS = 4000;             // cap at 4s

// "ip|username" → { count, lockedUntil, timerId }. Keyed by client too, so failures from
// one address cannot lock the admin out everywhere.
const failedAttempts = new Map();

function getAttemptEntry(username) {
  return failedAttempts.get(username) || { count: 0, lockedUntil: 0, timerId: null };
}

function recordFailure(username) {
  const entry = getAttemptEntry(username);
  // Cancel the previous cleanup timer so only one is active per username
  if (entry.timerId) clearTimeout(entry.timerId);
  const count = entry.count + 1;
  const lockedUntil =
    count >= MAX_FAILED_ATTEMPTS ? Date.now() + LOCKOUT_DURATION_MS : entry.lockedUntil;
  // Auto-cleanup so the map doesn't grow unbounded
  const timerId = setTimeout(
    () => failedAttempts.delete(username),
    LOCKOUT_DURATION_MS + 5000
  );
  if (typeof timerId.unref === "function") timerId.unref();
  failedAttempts.set(username, { count, lockedUntil, timerId });
  return { count, lockedUntil };
}

function clearFailures(username) {
  failedAttempts.delete(username);
}

function checkLockout(username) {
  const entry = getAttemptEntry(username);
  if (entry.lockedUntil > Date.now()) {
    return Math.ceil((entry.lockedUntil - Date.now()) / 1000); // seconds remaining
  }
  return 0;
}

function progressiveDelay(username) {
  const { count } = getAttemptEntry(username);
  const ms = Math.min(count * BASE_DELAY_MS, MAX_DELAY_MS);
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

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
    // Still expose it so the next dashboard save can persist it (app.js
    // falls back to process.env when the config has no secret yet).
    process.env.JWT_SECRET = newSecret;
  }

  return newSecret;
}

// Initialize JWT_SECRET once at module load (CRITICAL: must be constant for token verification)
const JWT_SECRET = getOrGenerateJwtSecret();

// Revoked token JTIs, kept on disk until the token would have expired anyway,
// so a logged-out session stays logged out after a restart
const MAX_REVOKE_TTL_MS = AUTH_TOKEN_MAX_AGE_MS;
const revokedTokens = new PersistentMap("revoked-sessions", MAX_REVOKE_TTL_MS, {
  validateValue: (v) => v === true,
});

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
    revokedTokens.set(decoded.jti, true, Math.min(ttlFromExpMs, MAX_REVOKE_TTL_MS));
    revokedTokens.flush();
  } catch (_) {
    // Ignore invalid or unverifiable tokens; they cannot be revoked
  }
}

function isTokenRevoked(jti) {
  return revokedTokens.has(jti);
}

export { WEBHOOK_SECRET } from "./secrets.js";

export const authenticateToken = (req, res, next) => {
  const token = req.cookies.auth_token;

  if (!token) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    // Ensure the decoded token payload is an object; non-object payloads are rejected
    if (!user || typeof user !== "object") {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    // Every session token carries a jti so it can be revoked
    if (!user.jti || isTokenRevoked(user.jti)) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    req.user = user;
    next();
  });
};

/** Starts a dashboard session (HttpOnly cookie). */
export function issueSession(req, res, { id, username, method = "local" }) {
  const token = jwt.sign({ id, username, method, jti: crypto.randomUUID() }, JWT_SECRET, {
    expiresIn: AUTH_TOKEN_EXPIRATION,
  });
  res.cookie("auth_token", token, {
    httpOnly: true,
    secure: req.secure,
    sameSite: "strict",
    maxAge: AUTH_TOKEN_MAX_AGE_MS,
  });
}

export const login = async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res
      .status(400)
      .json({ success: false, message: "Username and password are required" });
  }

  const attemptKey = `${req.ip}|${username}`;

  // Check lockout before doing anything else
  const secondsRemaining = checkLockout(attemptKey);
  if (secondsRemaining > 0) {
    logger.warn(`🔒 Login blocked for "${username}" — account locked (${secondsRemaining}s remaining, from ${req.ip})`);
    return res.status(429).json({
      success: false,
      message: `Too many failed attempts. Try again in ${secondsRemaining} seconds.`,
    });
  }

  const users = getUsers();
  const user = users.find((u) => u.username === username);

  // Always run bcrypt compare to prevent user-enumeration via timing
  const dummyHash = "$2a$12$invalidhashpaddingtomatchbcryptlength000000000000000000000";
  const validPassword = user
    ? await bcrypt.compare(password, user.password)
    : await bcrypt.compare(password, dummyHash).then(() => false);

  if (!user || !validPassword) {
    await progressiveDelay(attemptKey);
    const { count } = recordFailure(attemptKey);
    const attemptsLeft = MAX_FAILED_ATTEMPTS - count;
    if (attemptsLeft <= 0) {
      logger.warn(`🔒 Account "${username}" locked after ${MAX_FAILED_ATTEMPTS} failed attempts (from ${req.ip})`);
      return res.status(429).json({
        success: false,
        message: `Too many failed attempts. Account locked for ${Math.ceil(LOCKOUT_DURATION_MS / 60000)} minutes.`,
      });
    }
    logger.warn(`⚠️ Failed login for "${username}" — ${count}/${MAX_FAILED_ATTEMPTS} attempts (from ${req.ip})`);
    return res
      .status(401)
      .json({ success: false, message: "Invalid credentials" });
  }

  clearFailures(attemptKey);

  issueSession(req, res, { id: user.id, username: user.username });

  res.json({
    success: true,
    message: "Logged in successfully",
    username: user.username,
  });
};

/** Dashboard sign-in with a Moka administrator account, once Moka is connected. */
export const loginWithMoka = async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ success: false, message: "Username and password are required" });
  }
  if (!isMokaMode()) return res.status(400).json({ success: false, message: "Moka is not connected yet" });
  const attemptKey = `${req.ip}|moka:${username}`;
  const secondsRemaining = checkLockout(attemptKey);
  if (secondsRemaining > 0) {
    return res.status(429).json({ success: false, message: `Too many failed attempts. Try again in ${secondsRemaining} seconds.` });
  }
  let session;
  try {
    session = await mokaSignIn(mokaUrl(), username, password);
  } catch (err) {
    if (err.response?.status === 401) {
      await progressiveDelay(attemptKey);
      recordFailure(attemptKey);
      logger.warn(`⚠️ Failed Moka sign-in for "${username}" (from ${req.ip})`);
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }
    if (err.response?.status === 429) return res.status(429).json({ success: false, message: "Moka asks to wait before trying again" });
    logger.error(`Moka sign-in failed: ${err.message}`);
    return res.status(502).json({ success: false, message: "Could not reach Moka" });
  }
  // Only the answer matters: end the Moka session right away
  await mokaSignOut(mokaUrl(), session.cookie);
  if (!(Number(session.me?.permissions) & MOKA_ADMIN)) {
    return res.status(403).json({ success: false, message: "Only Moka administrators can manage Anchorr" });
  }
  clearFailures(attemptKey);
  issueSession(req, res, { id: `moka:${session.me.id}`, username: session.me.username, method: "moka" });
  res.json({ success: true, message: "Logged in successfully", username: session.me.username });
};

/** Dashboard sign-in with a Jellyfin administrator account. */
export const loginWithJellyfin = async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ success: false, message: "Username and password are required" });
  }
  if (!settings.JELLYFIN_BASE_URL) {
    return res.status(400).json({ success: false, message: "Jellyfin is not set up yet" });
  }

  const attemptKey = `${req.ip}|jellyfin:${username}`;
  const secondsRemaining = checkLockout(attemptKey);
  if (secondsRemaining > 0) {
    return res.status(429).json({ success: false, message: `Too many failed attempts. Try again in ${secondsRemaining} seconds.` });
  }

  let session;
  try {
    session = await signIn(settings.JELLYFIN_BASE_URL, username, password);
  } catch (err) {
    if (err.response?.status === 401) {
      await progressiveDelay(attemptKey);
      recordFailure(attemptKey);
      logger.warn(`⚠️ Failed Jellyfin sign-in for "${username}" (from ${req.ip})`);
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }
    logger.error(`Jellyfin sign-in failed: ${err.message}`);
    return res.status(502).json({ success: false, message: "Could not reach Jellyfin" });
  }
  await signOut(settings.JELLYFIN_BASE_URL, session.token);

  if (!session.isAdmin) {
    return res.status(403).json({ success: false, message: "Only Jellyfin administrators can manage Anchorr" });
  }
  clearFailures(attemptKey);
  issueSession(req, res, { id: `jellyfin:${session.userId}`, username: session.username, method: "jellyfin" });
  res.json({ success: true, message: "Logged in successfully", username: session.username });
};

export const register = async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res
      .status(400)
      .json({ success: false, message: "Username and password are required" });
  }

  const users = getUsers();

  // One local account, created from a signed-in session (Jellyfin admin) so nobody can
  // claim a fresh install just by reaching the dashboard first (audit S4)
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
    issueSession(req, res, { id: newUser.id, username: newUser.username });

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

// Which sign-in methods the login screen should offer
function loginOptions(users) {
  const jellyfinReady = Boolean(settings.JELLYFIN_BASE_URL && settings.JELLYFIN_API_KEY);
  return {
    hasUsers: users.length > 0,
    jellyfinLogin: jellyfinReady,
    ...(isMokaMode() && { mokaLogin: true }),
    needsSetup: !jellyfinReady && !isMokaMode() && users.length === 0,
  };
}

export const checkAuth = (req, res) => {
  const token = req.cookies.auth_token;
  if (!token) {
    // Check if any users exist to determine if we should show register or login
    const users = getUsers();
    return res.json({ isAuthenticated: false, ...loginOptions(users) });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      const users = getUsers();
      return res.json({ isAuthenticated: false, ...loginOptions(users) });
    }
    // Mirror authenticateToken's revocation behavior: accept legacy tokens without JTI,
    // and reject only tokens with a JTI that has been revoked
    if (!user || typeof user !== "object") {
      const users = getUsers();
      return res.json({ isAuthenticated: false, ...loginOptions(users) });
    }
    if (!user.jti || isTokenRevoked(user.jti)) {
      const users = getUsers();
      return res.json({ isAuthenticated: false, ...loginOptions(users) });
    }
    res.json({ isAuthenticated: true, user, ...loginOptions(getUsers()) });
  });
};
