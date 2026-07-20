const express = require('express');
const rateLimit = require('express-rate-limit');
const authController = require('../controllers/auth.controller');
const { validateRegistration, validateLogin, validateForgotPassword, validateResetPassword, validateUpdatePassword, validateMerchantAssignment } = require('../utils/validators/auth');
const { authMiddleware, requireAdmin, } = require('../middleware/auth.middleware');

const authRouter = express.Router();

// Tighter than the global /api/ limiter - caps bcrypt.compare calls per IP so
// distributed credential-stuffing can't peg the event loop (see 2026-07-20
// CPU-exhaustion incident). Account-level lockout in auth.service.js covers
// attacks spread across many IPs against a single account.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 'error',
    message: 'Too many login attempts. Please try again in a few minutes.',
  },
});

// Public routes
authRouter.post('/register', validateRegistration, authController.register);
authRouter.post('/login', loginLimiter, validateLogin, authController.login);
authRouter.post('/forgot-password', validateForgotPassword, authController.forgotPassword);
authRouter.post('/reset-password', validateResetPassword, authController.resetPassword);

// Protected routes (require authentication)
authRouter.use(authMiddleware);

// General authenticated user routes
authRouter.get('/me', authController.getCurrentUser);
authRouter.get('/earnings', authController.getUserEarnings);
authRouter.get('/referrals', authController.getUserReferrals);
authRouter.post('/logout', authController.logout);
authRouter.put('/update-password', validateUpdatePassword, authController.updatePassword);




module.exports = authRouter;