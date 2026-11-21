import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authenticateToken, checkAuth, login, loginWithJellyfin, loginWithMoka, logout, register } from "../utils/auth.js";

const router = Router();

// Counts failed sign-ins only. Guessing is also slowed down and locked per address and
// username in utils/auth.js; this is the coarse cap per address on top of that.
const signInLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  skipSuccessfulRequests: true,
  message: { success: false, message: "Too many failed sign-ins from this address. Try again in a few minutes." },
  standardHeaders: true,
  legacyHeaders: false,
});

// The dashboard calls this on every page load; a flood guard only, like the rest of /api
const checkLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 1000, standardHeaders: true, legacyHeaders: false });

router.post("/auth/login", signInLimiter, login);
router.post("/auth/jellyfin", signInLimiter, loginWithJellyfin);
router.post("/auth/moka", signInLimiter, loginWithMoka);
// The single local account is added from a signed-in session (audit S4)
router.post("/auth/register", signInLimiter, authenticateToken, register);
router.post("/auth/logout", logout);
// Read-only and called on every page load, so it never counts as an attempt
router.get("/auth/check", checkLimiter, checkAuth);

export default router;
