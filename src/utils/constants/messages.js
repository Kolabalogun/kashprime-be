const MESSAGES = {
  // Success messages
  SUCCESS: {
    REGISTRATION: 'Registration successful',
    LOGIN: 'Login successful',
    PROFILE_UPDATED: 'Profile updated successfully',
    PASSWORD_CHANGED: 'Password changed successfully',
    PASSWORD_RESET: 'Password reset successful',
    PASSWORD_RESET_SENT: 'Password reset instructions sent to your email',
    UPGRADE_SUCCESSFUL: 'Account upgraded to Pro successfully',
    LOGOUT: 'Logout successful',
  },
 
 

  // Error messages
  ERROR: {
    EMAIL_EXISTS: 'Email already exists',
    USERNAME_EXISTS: 'Username already exists',
    INVALID_CREDENTIALS: 'Invalid email/username or password',
    INVALID_PACKAGE_CODE: 'Invalid or already used package code',
    USER_NOT_FOUND: 'User not found',
    EMAIL_NOT_FOUND: 'No account found with this email address',
    INVALID_RESET_TOKEN: 'Invalid or expired reset token',
    CURRENT_PASSWORD_INCORRECT: 'Current password is incorrect',
    UNAUTHORIZED: 'Unauthorized access',
    VALIDATION_ERROR: 'Validation error',
    SERVER_ERROR: 'Internal server error',
    MISSING_FIELDS: 'Required fields are missing',
    WEAK_PASSWORD: 'Password must be at least 8 characters long',
    INVALID_EMAIL: 'Invalid email format',
    INVALID_USERNAME: 'Username must be at least 3 characters and contain only letters and numbers',
       INVALID_CODE: 'Invalid or already used upgrade code',
    WRONG_PACKAGE: 'This code is not for Pro package upgrade',
    ALREADY_PRO: 'Your account is already a Pro account',
    CODE_REQUIRED: 'Upgrade code is required',
    UPGRADE_FAILED: 'Failed to upgrade account',
    ACCOUNT_LOCKED: 'Too many failed login attempts. Please try again in a few minutes.',



    
  },

  // Field validation
  VALIDATION: {
    REQUIRED: 'This field is required',
    MIN_LENGTH: 'Must be at least {min} characters',
    MAX_LENGTH: 'Must be at most {max} characters',
    INVALID_FORMAT: 'Invalid format'
  }
};

module.exports = MESSAGES;