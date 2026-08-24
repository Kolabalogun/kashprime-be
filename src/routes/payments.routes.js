const express = require('express');
const { body, query } = require('express-validator');
const PaymentController = require('../controllers/payments.controller');
const { authMiddleware, requireAdmin } = require('../middleware/auth.middleware');

const router = express.Router();

// Validation rules
const paymentValidation = [
  body('reference')
    .notEmpty()
    .withMessage('Payment reference is required')
    .isLength({ min: 10 })
    .withMessage('Invalid payment reference format'),
  
  body('amount')
    .isFloat({ min: 50 })
    .withMessage('Minimum deposit amount is ₦50')
    .isFloat({ max: 1000000 })
    .withMessage('Maximum deposit amount is ₦1,000,000'),
  
  body('purpose')
    .notEmpty()
    .withMessage('Purpose is required')
    .isIn(['gaming', 'investment', 'upgrade'])
    .withMessage('Purpose must be one of: gaming, investment, upgrade')
];

const initializePaymentValidation = [
  body('amount')
    .isFloat({ min: 50 })
    .withMessage('Minimum deposit amount is ₦50')
    .isFloat({ max: 1000000 })
    .withMessage('Maximum deposit amount is ₦1,000,000'),
  
  body('email')
    .optional()
    .isEmail()
    .withMessage('Valid email is required'),
  
  body('purpose')
    .notEmpty()
    .withMessage('Purpose is required')
    .isIn(['gaming', 'investment', 'upgrade'])
    .withMessage('Purpose must be one of: gaming, investment, upgrade')
];

const transactionHistoryValidation = [
  query('page')
    .optional()
    .isInt({ min: 1 })
    .withMessage('Page must be a positive integer'),
  
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('Limit must be between 1 and 100'),
  
  query('type')
    .optional()
    .isIn(['deposit', 'upgrade_payment', 'reward'])
    .withMessage('Invalid transaction type'),
  
  query('purpose')
    .optional()
    .isIn(['gaming', 'investment', 'upgrade'])
    .withMessage('Invalid purpose')
];   

const adminTransactionValidation = [
  query('page')
    .optional()
    .isInt({ min: 1 })
    .withMessage('Page must be a positive integer'),
  
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('Limit must be between 1 and 100'),
  
  query('purpose')
    .optional()
    .isIn(['gaming', 'investment', 'upgrade', 'kash_ads'])
    .withMessage('Invalid purpose'),
  
  query('status')
    .optional()
    .isIn(['pending', 'completed', 'failed', 'cancelled'])
    .withMessage('Invalid status'),
  
  query('user_id')
    .optional()
    .isUUID()
    .withMessage('Invalid user ID format'),
  
  query('date_from')
    .optional()
    .isISO8601()
    .withMessage('Invalid date format (use ISO 8601)'),
  
  query('date_to')
    .optional()
    .isISO8601()
    .withMessage('Invalid date format (use ISO 8601)')
];

// User Routes

/**
 * @route   GET /api/payments/settings
 * @desc    Get public payment gateway settings
 * @access  Public
 */
router.get('/settings',
  PaymentController.getPublicSettings
);

/**
 * @route   POST /api/payments/initialize
 * @desc    Initialize payment with Paystack or Flutterwave
 * @access  Private
 */
router.post('/initialize',
  authMiddleware,
  [
    body('amount').isFloat({ min: 50 }).withMessage('Minimum deposit amount is ₦50'),
    body('email').optional().isEmail().withMessage('Valid email is required'),
    body('purpose').notEmpty().isIn(['gaming', 'investment', 'upgrade', 'kash_ads']),
    body('gateway').optional().isIn(['movantrapay', 'paystack', 'flutterwave'])
  ],
  PaymentController.initializePayment
);

/**
 * @route   POST /api/payments/verify
 * @desc    Verify payment and credit appropriate wallet
 * @access  Private
 */
router.post('/verify', 
  authMiddleware,
  [
    body('reference').notEmpty(),
    body('amount').isFloat({ min: 50 }),
    body('purpose').notEmpty().isIn(['gaming', 'investment', 'upgrade', 'kash_ads']),
    body('gateway').optional().isIn(['movantrapay', 'paystack', 'flutterwave']),
    body('flw_transaction_id').optional()
  ],
  PaymentController.verifyPayment
);

/**
 * @route   GET /api/payments/movantrapay/status/:reference
 * @desc    Check status of a Movantrapay checkout reference
 * @access  Private
 */
router.get('/movantrapay/status/:reference',
  authMiddleware,
  PaymentController.checkMovantrapayStatus
);

/**
 * @route   POST /api/payments/movantrapay/webhook
 * @desc    Handle Movantrapay webhook events
 * @access  Public (secured with HMAC SHA-512 signature)
 */
router.post('/movantrapay/webhook',
  express.raw({ type: 'application/json' }),
  PaymentController.handleMovantrapayWebhook
);

/**
 * @route   POST /api/payments/flutterwave/verify
 * @desc    Dedicated Flutterwave payment verification
 * @access  Private
 */
router.post('/flutterwave/verify',
  authMiddleware,
  [
    body('transaction_id').notEmpty().withMessage('Transaction ID is required'),
    body('tx_ref').notEmpty().withMessage('Transaction reference is required'),
    body('amount').isFloat({ min: 50 }).withMessage('Valid amount is required'),
    body('purpose').notEmpty().isIn(['gaming', 'investment', 'upgrade', 'kash_ads'])
  ],
  PaymentController.verifyFlutterwavePayment
);

const redeemValidation = [
  body('code')
    .notEmpty()
    .withMessage('Deposit code is required')
    .isString()
    .isLength({ min: 16, max: 16 })
    .withMessage('Invalid code format. Code must be 16 characters.'),
  
  body('purpose')
    .notEmpty()
    .withMessage('Purpose is required (e.g. gaming)')
];

/**
 * @route   GET /api/payments/transactions
 * @desc    Get user transaction history
 * @access  Private
 */
router.get('/transactions',
  authMiddleware,
  transactionHistoryValidation,
  PaymentController.getTransactionHistory
);

/**
 * @route   POST /api/payments/redeem-code
 * @desc    Redeem a deposit code for funds
 * @access  Private
 */
router.post('/redeem-code',
  authMiddleware,
  redeemValidation,
  PaymentController.redeemCode
);

/**
 * @route   POST /api/payments/webhook
 * @desc    Handle Paystack webhook events
 * @access  Public (secured with signature verification)
 */
router.post('/webhook',
  express.raw({ type: 'application/json' }),
  PaymentController.handleWebhook
);

// Admin Routes

/**
 * @route   GET /api/payments/admin/all-transactions
 * @desc    Get all payment transactions across all users (Admin only)
 * @access  Private (Admin)
 */
router.get('/admin/all-transactions',
  authMiddleware,
  requireAdmin,
  adminTransactionValidation,
  PaymentController.getAllPaymentTransactions
);

module.exports = router;