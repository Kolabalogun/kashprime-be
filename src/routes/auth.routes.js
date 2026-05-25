const express = require('express');
const authController = require('../controllers/auth.controller');
const { validateRegistration, validateLogin, validateForgotPassword, validateResetPassword, validateUpdatePassword, validateMerchantAssignment } = require('../utils/validators/auth');
const { authMiddleware, requireAdmin, } = require('../middleware/auth.middleware');

const authRouter = express.Router();



// Public routes
authRouter.post('/register', validateRegistration, authController.register);
authRouter.post('/login', validateLogin, authController.login);
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