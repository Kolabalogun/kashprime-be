const express = require('express');
const { body, query, param } = require('express-validator');
const rateLimit = require('express-rate-limit');
const investmentController = require('../controllers/investment.controller');
const { authMiddleware, requireAdmin } = require('../middleware/auth.middleware');

const router = express.Router();

// Rate limiters
const paymentLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: {
    status: 'error',
    message: 'Too many payment requests. Please try again later.'
  }
});

const withdrawalLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: {
    status: 'error',
    message: 'Too many withdrawal requests. Please try again later.'
  }
});

// Validation rules
const initializePaymentValidation = [
  body('plan_name')
    .notEmpty()
    .withMessage('Plan name is required')
    .isIn(['starter', 'amateur', 'semi_amateur', 'pro', 'master'])
    .withMessage('Invalid plan name')
];

const verifyPaymentValidation = [
  body('reference')
    .notEmpty()
    .withMessage('Payment reference is required')
];

const withdrawalValidation = [
  body('amount')
    .isFloat({ min: 1 })
    .withMessage('Amount must be a positive number')
];

const transferValidation = [
  body('amount')
    .isFloat({ min: 1 })
    .withMessage('Amount must be a positive number')
];

const processWithdrawalValidation = [
  body('action')
    .isIn(['approve', 'decline'])
    .withMessage('Action must be either approve or decline'),
  body('decline_reason')
    .if(body('action').equals('decline'))
    .notEmpty()
    .withMessage('Decline reason is required when declining')
];

const bulkProcessValidation = [
  body('transaction_ids')
    .isArray({ min: 1, max: 50 })
    .withMessage('transaction_ids must be an array with 1-50 items'),
  body('action')
    .isIn(['approve', 'decline'])
    .withMessage('Action must be either approve or decline'),
  body('decline_reason')
    .if(body('action').equals('decline'))
    .notEmpty()
    .withMessage('Decline reason is required when declining')
];

// ==================== USER ROUTES ====================

/**
 * @route   GET /api/investments/plans
 * @desc    Get available investment plans
 * @access  Private
 */
router.get('/plans', authMiddleware, investmentController.getPlans);

/**
 * @route   POST /api/investments/invest-from-balance
 * @desc    Invest in plan using investment_balance or games_balance
 * @access  Private
 */
router.post('/invest-from-balance', authMiddleware, investmentController.investFromBalance);

/**
 * @route   GET /api/investments/my-investments
 * @desc    Get user's investments
 * @access  Private
 */
router.get(
  '/my-investments',
  authMiddleware,
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('status').optional().isIn(['active', 'completed'])
  ],
  investmentController.getMyInvestments
);

/**
 * @route   GET /api/investments/dashboard
 * @desc    Get investment dashboard
 * @access  Private
 */
router.get('/dashboard', authMiddleware, investmentController.getDashboard);

/**
 * @route   POST /api/investments/withdraw
 * @desc    Request withdrawal from investment balance
 * @access  Private
 */
router.post(
  '/withdraw',
  authMiddleware,
  withdrawalLimiter,
  withdrawalValidation,
  investmentController.requestWithdrawal
);

/**
 * @route   POST /api/investments/transfer-to-games
 * @desc    Transfer from investment balance to games balance
 * @access  Private
 */
router.post(
  '/transfer-to-games',
  authMiddleware,
  transferValidation,
  investmentController.transferToGames
);


/**
 * @route   GET /api/investments/:investmentId
 * @desc    Get single investment details
 * @access  Private
 */
router.get(
  '/:investmentId',
  authMiddleware,
  [param('investmentId').isUUID()],
  investmentController.getInvestmentDetails
);



// ==================== ADMIN ROUTES ====================

/**
 * @route   GET /api/investments/admin/all
 * @desc    Get all investments (admin)
 * @access  Private (Admin)
 */
router.get(
  '/admin/all',
  authMiddleware,
  requireAdmin,
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('status').optional().isIn(['active', 'completed']),
    query('search').optional().isString()
  ],
  investmentController.adminGetAllInvestments
);

/**
 * @route   GET /api/investments/admin/stats
 * @desc    Get investment statistics (admin)
 * @access  Private (Admin)
 */
router.get(
  '/admin/stats',
  authMiddleware,
  requireAdmin,
  investmentController.adminGetInvestmentStats
);

/**
 * @route   POST /api/investments/admin/process-payouts
 * @desc    Process weekly payouts manually (admin)
 * @access  Private (Admin)
 */
router.post(
  '/admin/process-payouts',
  authMiddleware,
  requireAdmin,
  investmentController.adminProcessWeeklyPayouts
);

/**
 * @route   GET /api/investments/admin/withdrawals/pending
 * @desc    Get pending investment withdrawals (admin)
 * @access  Private (Admin)
 */
router.get(
  '/admin/withdrawals/pending',
  authMiddleware,
  requireAdmin,
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('search').optional().isString()
  ],
  investmentController.adminGetPendingWithdrawals
);

/**
 * @route   PUT /api/investments/admin/withdrawals/:transactionId/process
 * @desc    Process investment withdrawal (admin)
 * @access  Private (Admin)
 */
router.put(
  '/admin/withdrawals/:transactionId/process',
  authMiddleware,
  requireAdmin,
  [param('transactionId').isUUID()],
  processWithdrawalValidation,
  investmentController.adminProcessWithdrawal
);

/**
 * @route   PUT /api/investments/admin/withdrawals/bulk-process
 * @desc    Bulk process investment withdrawals (admin)
 * @access  Private (Admin)
 */
router.put(
  '/admin/withdrawals/bulk-process',
  authMiddleware,
  requireAdmin,
  bulkProcessValidation,
  investmentController.adminBulkProcessWithdrawals
);

module.exports = router;