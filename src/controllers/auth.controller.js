const { validationResult } = require('express-validator');
const authService = require('../services/auth.service');
const { formatResponse } = require('../utils/helpers');
const { logActivity } = require('../utils/activityLogger');
const MESSAGES = require('../utils/constants/messages');
const { getFirstValidationError, formatValidationErrors } = require('../utils/validators/auth');

// Register
const register = async (req, res) => {
  try {
    const errors = validationResult(req);
    
    if (!errors.isEmpty()) {
      const firstError = getFirstValidationError(errors.array());
      
      return res.status(400).json({
        status: 'error',
        message: firstError,
        data: {
          field_errors: formatValidationErrors(errors.array()),
          errors: errors.array()
        }
      });
    }
    // Capture IP Address
    const ip_address = req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress;
    req.body.ip_address = ip_address;

    const result = await authService.registerUser(req.body);
    
    // Log Activity
    if (result && result.user) {
      await logActivity(result.user.id, 'register', { email: result.user.email }, req);
    }

    res.status(201).json({
      status: 'success',
      message: 'Registration successful! Welcome!',
      data: result
    });

  } catch (error) {
    console.error('Registration error:', error);
    
    let errorMessage = 'Registration failed. Please try again.';
    
    if (error.message.includes('EMAIL_EXISTS')) {
      errorMessage = 'This email address is already registered. Please use a different email or try logging in.';
    } else if (error.message.includes('USERNAME_EXISTS') || error.message.includes('users_username_key') || error.message.includes('users_referral_code_key')) {
      errorMessage = 'This username is already taken. Please choose a different username.';
    } else if (error.message) {
      errorMessage = error.message;
    }
    
    res.status(400).json({
      status: 'error',
      message: errorMessage
    });
  }
};

// Login
const login = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json(
        formatResponse('error', MESSAGES.ERROR.VALIDATION_ERROR, {
          errors: errors.array()
        })
      );
    }

    const { credential, password } = req.body;
    const result = await authService.loginUser(credential, password);
    
    // Log Activity
    if (result && result.user) {
      await logActivity(result.user.id, 'login', { method: credential.includes('@') ? 'email' : 'username' }, req);
    }

    res.status(200).json(
      formatResponse('success', MESSAGES.SUCCESS.LOGIN, result)
    );

  } catch (error) {
    console.error('Login error:', error);
    const status = error.message === MESSAGES.ERROR.ACCOUNT_LOCKED ? 403 : 401;
    res.status(status).json(
      formatResponse('error', error.message)
    );
  }
};

// Forgot password
const forgotPassword = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json(
        formatResponse('error', MESSAGES.ERROR.VALIDATION_ERROR, {
          errors: errors.array()
        })
      );
    }

    const { email } = req.body;
    const result = await authService.forgotPassword(email);
    
    res.status(200).json(
      formatResponse('success', MESSAGES.SUCCESS.PASSWORD_RESET_SENT, result)
    );

  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(400).json(
      formatResponse('error', error.message)
    );
  }
};

// Reset password
const resetPassword = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json(
        formatResponse('error', MESSAGES.ERROR.VALIDATION_ERROR, {
          errors: errors.array()
        })
      );
    }

    const { email, otp, password } = req.body;
    const result = await authService.resetPasswordWithOTP(email, otp, password);
    
    res.status(200).json(
      formatResponse('success', MESSAGES.SUCCESS.PASSWORD_RESET, result)
    );

  } catch (error) {
    console.error('Reset password error:', error);
    res.status(400).json(
      formatResponse('error', error.message)
    );
  }
};

// Get current user
const getCurrentUser = async (req, res) => {
  try {
    const user = await authService.getUserProfile(req.user.id);
    
    res.status(200).json(
      formatResponse('success', 'User profile retrieved', { user })
    );

  } catch (error) {
    console.error('Get user error:', error);
    res.status(404).json(
      formatResponse('error', error.message)
    );
  }
};

const getUserEarnings = async (req, res) => {
  try {
    const earnings = await authService.getUserEarnings(req.user.id);
    
    res.status(200).json(
      formatResponse('success', 'User earnings retrieved successfully', earnings)
    );

  } catch (error) {
    console.error('Get user earnings error:', error);
    res.status(500).json(
      formatResponse('error', error.message)
    );
  }
};

// Update password
const updatePassword = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json(
        formatResponse('error', MESSAGES.ERROR.VALIDATION_ERROR, {
          errors: errors.array()
        })
      );
    }

    const { currentPassword, newPassword } = req.body;
    const result = await authService.updatePassword(req.user.id, currentPassword, newPassword);
    
    res.status(200).json(
      formatResponse('success', MESSAGES.SUCCESS.PASSWORD_CHANGED, result)
    );

  } catch (error) {
    console.error('Update password error:', error);
    res.status(400).json(
      formatResponse('error', error.message)
    );
  }
};

// Get user referrals
const getUserReferrals = async (req, res) => {
  try {
    const referrals = await authService.getUserReferrals(req.user.id);
    
    res.status(200).json(
      formatResponse('success', 'Referrals retrieved successfully', referrals)
    );

  } catch (error) {
    console.error('Get referrals error:', error);
    res.status(500).json(
      formatResponse('error', error.message)
    );
  }
};

// Logout
const logout = async (req, res) => {
  try {
    res.status(200).json(
      formatResponse('success', MESSAGES.SUCCESS.LOGOUT)
    );
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json(
      formatResponse('error', MESSAGES.ERROR.SERVER_ERROR)
    );
  }
};

module.exports = {
  register,
  login,
  forgotPassword,
  resetPassword,
  getCurrentUser,
  updatePassword,
  getUserReferrals,getUserEarnings, 
  logout
};