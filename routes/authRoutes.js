import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authenticateToken, checkAuth, login, loginWithJellyfin, logout, register } from "../utils/auth.js";

const router = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, error: "Too many attempts, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post("/auth/login", authLimiter, login);
router.post("/auth/jellyfin", authLimiter, loginWithJellyfin);
// The single local account is added from a signed-in session (audit S4)
router.post("/auth/register", authLimiter, authenticateToken, register);
router.post("/auth/logout", logout);
router.get("/auth/check", authLimiter, checkAuth);

export default router;
