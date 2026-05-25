const express = require('express');
const rateLimit = require('express-rate-limit');
const { body, query } = require('express-validator');
const router = express.Router();

const adminController = require('../controllers/admin.controller');
const { authMiddleware, requireAdmin } = require('../middleware/auth.middleware');

// Rate limiting
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 100,  
  message: {
    status: 'error',
    message: 'Too many requests from this IP, please try again later.'
  }
});

const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 50,  
  message: {
    status: 'error',
    message: 'Too many requests, please try again later.'
  }
});


// ==================== PUBLIC ROUTES ====================

/**
 * GET /api/admin/leaderboard/top-earners
 * Get top 10 users with highest withdrawable balance (PUBLIC)
 */
router.get('/leaderboard/top-earners', publicLimiter, adminController.getTopEarners);

 

// Apply middleware to all routes
router.use(adminLimiter);
router.use(authMiddleware);
router.use(requireAdmin);





// ==================== USER MANAGEMENT ROUTES ====================

/**
 * Admin route to get detailed user earnings breakdown
 * GET /api/admin/user/:userId/earnings
 * Query params: ?days=30 (optional, defaults to 30 days for recent activity)
 */
router.get('/user/:userId/earnings', authMiddleware, requireAdmin, adminController.getUserEarningsAdmin);

/**
 * GET /api/admin/users
 * Get all users with filtering and pagination
 */
router.get('/users', [
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('search').optional().isLength({ max: 100 }),
  query('role').optional().isIn(['user', 'merchant', 'manager', 'admin', 'demo']),
  query('user_tier').optional().isIn(['Free', 'Amateur', 'Pro']),
  query('account_status').optional().isIn(['active', 'suspended', 'banned']),
  query('sort_by').optional().isIn(['created_at', 'username', 'full_name', 'user_tier']),
  query('sort_order').optional().isIn(['asc', 'desc'])
], adminController.getAllUsers);

/**
 * GET /api/admin/users/:userId
 * Get detailed user information
 */
router.get('/users/:userId', [
  query('userId').isUUID()
], adminController.getUserDetails);

/**
 * PUT /api/admin/users/:userId/status
 * Update user status, tier, or role
 */
router.put('/users/:userId/status', [
  body('account_status').optional().isIn(['active', 'suspended', 'banned']),
  body('user_tier').optional().isIn(['Free', 'Amateur', 'Pro']),
  body('role').optional().isIn(['user', 'merchant', 'manager', 'admin', 'demo'])
], adminController.updateUserStatus);

// ==================== WITHDRAWAL MANAGEMENT ROUTES ====================

/**
 * GET /api/admin/withdrawals/statistics
 * Get statistics for all withdrawal requests
 */
router.get('/withdrawals/statistics', adminController.getWithdrawalStatistics);

/**
 * GET /api/admin/withdrawals/pending
 * Get all pending withdrawal requests
 */
router.get('/withdrawals/pending', [
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('search').optional().isLength({ max: 100 }),
  query('sort_by').optional().isIn(['created_at', 'amount', 'username']),
  query('sort_order').optional().isIn(['asc', 'desc'])
], adminController.getPendingWithdrawals);

/**
 * PUT /api/admin/withdrawals/:transactionId/process
 * Process individual withdrawal (approve/decline)
 */
router.put('/withdrawals/:transactionId/process', [
  body('action').isIn(['approve', 'decline']),
  body('decline_reason').optional().isLength({ max: 500 })
], adminController.processWithdrawal);

/**
 * PUT /api/admin/withdrawals/bulk-process
 * Bulk process multiple withdrawals
 */
router.put('/withdrawals/bulk-process', [
  body('transaction_ids').isArray({ min: 1, max: 50 }),
  body('transaction_ids.*').isUUID(),
  body('action').isIn(['approve', 'decline']),
  body('decline_reason').optional().isLength({ max: 500 })
], adminController.bulkProcessWithdrawals);

// ==================== KASHCOIN MANAGEMENT ROUTES ====================

/**
 * GET /api/admin/kashcoin/statistics
 * Get detailed analytics and statistics for KASHcoin
 */
router.get('/kashcoin/statistics', adminController.getKashcoinStatistics);

/**
 * GET /api/admin/kashcoin/eligible-users
 * Get users eligible for KASHcoin withdrawal (above threshold)
 */
router.get('/kashcoin/eligible-users', [
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('search').optional().isLength({ max: 100 }),
  query('sort_by').optional().isIn(['kashcoin_balance', 'created_at', 'username']),
  query('sort_order').optional().isIn(['asc', 'desc'])
], adminController.getKashcoinEligibleUsers);

/**
 * POST /api/admin/kashcoin/process-payments
 * Process KASHcoin payments for multiple users (deduct threshold)
 */
router.post('/kashcoin/process-payments', [
  body('user_ids').isArray({ min: 1, max: 100 }),
  body('user_ids.*').isUUID()
], adminController.processKashcoinPayments);

// ==================== SETTINGS MANAGEMENT ROUTES ====================

/**
 * GET /api/admin/settings
 * Get all platform settings
 */
router.get('/settings', adminController.getSettings);

/**
 * PUT /api/admin/settings
 * Update platform setting
 */
router.put('/settings', [
  body('setting_key').isLength({ min: 1, max: 100 }),
  body('setting_value').notEmpty()
], adminController.updateSetting);

// ==================== DASHBOARD ROUTES ====================

/**
 * GET /api/admin/dashboard/stats
 * Get admin dashboard statistics
 */
router.get('/dashboard/stats', adminController.getDashboardStats);

/**
 * GET /api/admin/game-analytics
 * Comprehensive game analytics (revenue, heatmap, success rates, retention, alerts)
 */
router.get('/game-analytics', adminController.getGameAnalytics);

// ==================== ACTIVITY MONITORING ROUTES ====================

/**
 * GET /api/admin/activities/analytics
 * Get dashboard analytics for all user activities
 */
router.get('/activities/analytics', adminController.getActivityAnalytics);

/**
 * GET /api/admin/user/:userId/activities
 * Get specific user's platform activities
 */
router.get('/user/:userId/activities', [
  query('userId').isUUID()
], adminController.getUserActivities);

/**
 * GET /api/admin/user/:userId/game-activities
 * Get specific user's game playing activities
 */
router.get('/user/:userId/game-activities', [
  query('userId').isUUID()
], adminController.getUserGameActivities);

// ==================== MERCHANT MANAGEMENT ROUTES ====================

/**
 * GET /api/admin/merchants/analytics
 * Get top-level merchant performance analytics
 */
router.get('/merchants/analytics', adminController.getMerchantAnalytics);

/**
 * GET /api/admin/merchants/list
 * Get detailed list of merchants with metrics
 */
router.get('/merchants/list', [
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('search').optional().isLength({ max: 100 }),
  query('status').optional().isIn(['active', 'suspended', 'banned']),
  query('sort_by').optional().isIn(['referralCount', 'revenue', 'engagement', 'created_at', 'username']),
  query('sort_order').optional().isIn(['asc', 'desc'])
], adminController.getMerchantsList);

/**
 * GET /api/admin/merchants/code-analytics
 * Get detailed analytics for recharge codes by merchant
 */
router.get('/merchants/code-analytics', adminController.getMerchantCodeAnalytics);

/**
 * GET /api/admin/merchants/:merchantId
 * Get detailed profile, referral tree, code inventory for a specific merchant
 */
router.get('/merchants/:merchantId', adminController.getMerchantDetail);

/**
 * POST /api/admin/merchants/:merchantId/load-vending-balance
 * Load vending balance specifically for a merchant
 */
router.post('/merchants/:merchantId/load-vending-balance', [
  body('amount').isFloat({ min: 1 })
], adminController.loadVendingBalance);

module.exports = router;
