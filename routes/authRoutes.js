import { Router } from "express";
import rateLimit from "express-rate-limit";
import { login, register, logout, checkAuth } from "../utils/auth.js";

const router = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, error: "Too many attempts, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post("/auth/login", authLimiter, login);
router.post("/auth/register", authLimiter, register);
router.post("/auth/logout", logout);
router.get("/auth/check", checkAuth);

export default router;
