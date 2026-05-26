const { supabaseAdmin } = require('../services/supabase.service');
const { formatResponse } = require('../utils/responseFormatter');

const DEMO_ROLE = 'demo';
const ADMIN_ROLE = 'admin';
const EXCLUDED_STATS_ROLES = [DEMO_ROLE, ADMIN_ROLE];

const getDemoUserIds = async () => {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id')
    .in('role', EXCLUDED_STATS_ROLES);

  if (error) throw error;
  return new Set((data || []).map((user) => user.id));
};

const filterOutDemoRows = (rows = [], demoUserIds = new Set(), key = 'user_id') => (
  (rows || []).filter((row) => !demoUserIds.has(row?.[key]))
);

/**
 * Controller for User-Submitted Advertising System
 */
const UserAdsController = {
  /**
   * Get current ad pricing and configuration
   */
  getPricing: async (req, res) => {
    try {
      let query = supabaseAdmin
        .from('kash_ad_pricing')
        .select('*');

      // Only filter if not admin-ish or if explicitly requested active
      // For now, let's just use a param or context. Since this is used by both, 
      // let's return all and let components filter, or better, add a check.
      if (req.query.active_only === 'true') {
        query = query.eq('is_active', true);
      }

      const { data, error } = await query;

      if (error) throw error;

      return res.status(200).json(formatResponse('success', 'Pricing fetched successfully', data));
    } catch (error) {
      console.error('Error in getPricing:', error);
      return res.status(500).json(formatResponse('error', 'Failed to fetch pricing', error.message));
    }
  },

  /**
   * Admin: Update ad pricing
   */
  adminUpdatePricing: async (req, res) => {
    const { id, daily_rate, min_duration_days, max_duration_days, is_active } = req.body;
    try {
      const { data, error } = await supabaseAdmin
        .from('kash_ad_pricing')
        .update({
          daily_rate,
          min_duration_days,
          max_duration_days,
          is_active,
          updated_at: new Date().toISOString()
        })
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;

      return res.status(200).json(formatResponse('success', 'Pricing updated successfully', data));
    } catch (error) {
      return res.status(500).json(formatResponse('error', 'Failed to update pricing', error.message));
    }
  },

  /**
   * Get active ads for display on the platform
   */
  getActiveAds: async (req, res) => {
    const { type } = req.query;
    try {

      // Lazy cleanup: Move expired active ads to 'paused' status automatically
      await supabaseAdmin
        .from('kash_ad_submissions')
        .update({ status: 'paused', updated_at: new Date().toISOString() })
        .eq('status', 'active')
        .lt('end_date', new Date().toISOString());

      let query = supabaseAdmin
        .from('kash_ad_submissions')
        .select('*')
        .eq('status', 'active')
        .gt('end_date', new Date().toISOString()); 

      if (type) {
        query = query.eq('ad_type', type);
      }

      const { data, error } = await query;
      if (error) throw error;

      return res.status(200).json(formatResponse('success', 'Active ads fetched', data));
    } catch (error) {
      return res.status(500).json(formatResponse('error', 'Failed to fetch active ads', error.message));
    }
  },

  /**
   * Submit a new advertisement
   */
  submitAd: async (req, res) => {
    const userId = req.user.id;
    const { 
      ad_type, 
      title, 
      description, 
      target_url, 
      media_url, 
      start_date, 
      total_days,
      payment_reference 
    } = req.body;

    try {
      // 0. Rate Limit: Max 10 ads per day
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const { count: adsToday, error: countError } = await supabaseAdmin
        .from('kash_ad_submissions')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .gte('created_at', today.toISOString());

      if (countError) throw countError;

      if (adsToday >= 10) {
        return res.status(429).json(formatResponse('error', 'Daily submission limit reached. You can only submit 10 ads per day.'));
      }

      // 1. Basic Validation
      if (!payment_reference) {
        return res.status(400).json(formatResponse('error', 'Payment reference is required'));
      }

      // Ensure target_url is provided for Link Ads
      if (ad_type === 'link_ad' && !target_url) {
        return res.status(400).json(formatResponse('error', 'Target URL is compulsory for Link Ads'));
      }

      // 2. Fetch pricing info (AND check if category is active)
      const { data: pricing, error: pricingError } = await supabaseAdmin
        .from('kash_ad_pricing')
        .select('*')
        .eq('ad_type', ad_type)
        .eq('is_active', true)
        .single();

      if (pricingError || !pricing) {
        return res.status(400).json(formatResponse('error', 'This ad type is currently unavailable for new submissions.'));
      }

      // 3. Validate duration
      if (total_days < pricing.min_duration_days || total_days > pricing.max_duration_days) {
        return res.status(400).json(formatResponse('error', `Duration must be between ${pricing.min_duration_days} and ${pricing.max_duration_days} days`));
      }

      const totalCost = parseFloat(pricing.daily_rate) * total_days;

      // 4. Verify Paystack Payment
      const { data: existingTx } = await supabaseAdmin
        .from('transactions')
        .select('id, amount, status')
        .eq('reference', payment_reference)
        .single();

      if (!existingTx) {
         return res.status(400).json(formatResponse('error', 'Payment transaction not found. Please verify payment first.'));
      }

      if (existingTx.status !== 'completed') {
         return res.status(400).json(formatResponse('error', 'Payment has not been completed'));
      }

      if (parseFloat(existingTx.amount) < totalCost) {
         return res.status(400).json(formatResponse('error', `Payment amount (₦${existingTx.amount}) is less than required cost (₦${totalCost})`));
      }

      // 5. Calculate end date
      const startDate = new Date(start_date);
      const endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + total_days);

      // 6. Create Submission record
      const { data: submission, error: subError } = await supabaseAdmin
        .from('kash_ad_submissions')
        .insert([
          {
            user_id: userId,
            ad_type,
            title,
            description,
            target_url,
            media_url,
            start_date: startDate.toISOString(),
            end_date: endDate.toISOString(),
            total_days,
            amount_paid: totalCost,
            transaction_id: payment_reference,
            status: 'pending'
          }
        ])
        .select()
        .single();

      if (subError) throw subError;

      // 7. Insert into audit table for record keeping
      await supabaseAdmin.from('kash_ad_payments').insert({
        ad_id: submission.id,
        user_id: userId,
        amount: totalCost,
        payment_reference: payment_reference,
        payment_type: 'deposit'
      });

      return res.status(201).json(formatResponse('success', 'Ad submitted successfully and is pending approval', submission));

    } catch (error) {
      console.error('Error in submitAd:', error);
      return res.status(500).json(formatResponse('error', 'Failed to submit ad', error.message));
    }
  },

  /**
   * Get user's own ad submissions
   */
  getMyAds: async (req, res) => {
    try {
      const { data, error } = await supabaseAdmin
        .from('kash_ad_submissions')
        .select('*')
        .eq('user_id', req.user.id)
        .order('created_at', { ascending: false });

      if (error) throw error;

      return res.status(200).json(formatResponse('success', 'Your ads fetched successfully', data));
    } catch (error) {
       return res.status(500).json(formatResponse('error', 'Failed to fetch your ads', error.message));
    }
  },

  /**
   * Record impression or click event
   */
  recordEvent: async (req, res) => {
    const { ad_id, event_type, metadata } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    try {
      // Basic anti-fraud: Don't track same IP/Type within 3 seconds
      const { data: recent } = await supabaseAdmin
        .from('kash_ad_events')
        .select('id')
        .eq('ad_id', ad_id)
        .eq('event_type', event_type)
        .eq('ip_address', ip)
        .gt('created_at', new Date(Date.now() - 3000).toISOString())
        .limit(1);

      if (recent && recent.length > 0) {
        return res.status(200).json(formatResponse('success', 'Activity tracked (throttled)'));
      }

      const { data, error } = await supabaseAdmin
        .from('kash_ad_events')
        .insert({
          ad_id,
          event_type,
          user_id: req.user?.id || null,
          ip_address: ip,
          user_agent: req.headers['user-agent'],
          metadata
        });

      if (error) throw error;

      return res.status(200).json(formatResponse('success', 'Event recorded successfully'));
    } catch (error) {
      return res.status(500).json(formatResponse('error', 'Failed to record event', error.message));
    }
  },

  /**
   * Admin: Get all ads for review
   */
  adminGetAds: async (req, res) => {
    const { status } = req.query;
    try {
      // Lazy cleanup for admin view as well
      await supabaseAdmin
        .from('kash_ad_submissions')
        .update({ status: 'paused', updated_at: new Date().toISOString() })
        .eq('status', 'active')
        .lt('end_date', new Date().toISOString());

      let query = supabaseAdmin
        .from('kash_ad_submissions')
        .select('*, users:user_id(username, email, full_name)')
        .order('created_at', { ascending: false });

      if (status) {
        query = query.eq('status', status);
      }

      const { data, error } = await query;
      if (error) {
        console.error('Supabase error in adminGetAds:', error);
        throw error;
      }

      return res.status(200).json(formatResponse('success', 'Ads fetched for admin', data));
    } catch (error) {
      console.error('Internal catch in adminGetAds:', error);
      return res.status(500).json(formatResponse('error', 'Failed to fetch ads', error.message));
    }
  },

  /**
   * Admin: Process ad (Approve/Reject)
   */
  adminProcessAd: async (req, res) => {
    const { ad_id, action, notes } = req.body;
    const adminId = req.user.id;

    try {
      if (!['approved', 'rejected'].includes(action)) {
        return res.status(400).json(formatResponse('error', 'Invalid action. Must be approved or rejected.'));
      }

      const { data: ad, error: adError } = await supabaseAdmin
        .from('kash_ad_submissions')
        .select('*')
        .eq('id', ad_id)
        .single();

      if (adError || !ad) {
        return res.status(404).json(formatResponse('error', 'Ad submission not found'));
      }

      if (ad.status !== 'pending') {
        return res.status(400).json(formatResponse('error', `Ad is already ${ad.status}`));
      }

      const updates = {
        status: action === 'approved' ? 'active' : 'rejected',
        admin_notes: notes,
        reviewed_at: new Date().toISOString(),
        reviewed_by: adminId,
        updated_at: new Date().toISOString()
      };

      const { data: updatedAd, error: updateError } = await supabaseAdmin
        .from('kash_ad_submissions')
        .update(updates)
        .eq('id', ad_id)
        .select()
        .single();

      if (updateError) throw updateError;

      // Handle Rejection Refund -> To GAME BALANCE
      if (action === 'rejected') {
        const { data: wallet } = await supabaseAdmin
          .from('wallets')
          .select('games_balance')
          .eq('user_id', ad.user_id)
          .single();

        if (wallet) {
          const newBalance = parseFloat(wallet.games_balance || 0) + parseFloat(ad.amount_paid);
          await supabaseAdmin.from('wallets').update({ games_balance: newBalance }).eq('user_id', ad.user_id);
          
          await supabaseAdmin.from('transactions').insert({
            user_id: ad.user_id,
            transaction_type: 'refund',
            balance_type: 'games_balance',
            amount: ad.amount_paid,
            status: 'completed',
            reference: `AD-REF-${Date.now()}`,
            description: `Refund for rejected ad: ${ad.title}`
          });

          await supabaseAdmin.from('kash_ad_payments').insert({
            ad_id: ad.id,
            user_id: ad.user_id,
            amount: ad.amount_paid,
            payment_type: 'refund'
          });
        }
      }

      return res.status(200).json(formatResponse('success', `Ad has been ${action}`, updatedAd));

    } catch (error) {
      console.error('Error in adminProcessAd:', error);
      return res.status(500).json(formatResponse('error', 'Failed to process ad', error.message));
    }
  },

  /**
   * Admin: Get Advanced Analytics
   */
  adminGetAnalytics: async (req, res) => {
    try {
      const demoUserIds = await getDemoUserIds();
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      // 1. Fetch event trend data from user-level events so demo traffic is excluded.
      const { data: performanceEvents, error: perfError } = await supabaseAdmin
        .from('kash_ad_events')
        .select('user_id, event_type, created_at')
        .gte('created_at', thirtyDaysAgo.toISOString())
        .order('created_at', { ascending: true })
        .limit(5000);

      if (perfError) throw perfError;
      const realPerformanceEvents = filterOutDemoRows(performanceEvents, demoUserIds);

      // 2. Financials: Separated Blocks
      
      // A. Internal Ad Revenue (from Advertisers) - Exclude refunds and non-processed
      const { data: revenueData, error: revError } = await supabaseAdmin
        .from('kash_ad_submissions')
        .select('user_id, amount_paid, status')
        .not('status', 'in', '("pending", "rejected")');

      if (revError) throw revError;
      const realRevenueData = filterOutDemoRows(revenueData, demoUserIds);
      const totalAdRevenue = realRevenueData.reduce((sum, ad) => sum + parseFloat(ad.amount_paid || 0), 0);

      // B. Click to Earn Payables (Paid to Users)
      const { data: earnersData, error: earnError } = await supabaseAdmin
        .from('kash_ads')
        .select('user_id, total_coins_earned, total_rewards_claimed');
        
      if (earnError) throw earnError;
      const realEarnersData = filterOutDemoRows(earnersData, demoUserIds);
      const totalUserPayables = realEarnersData.reduce((sum, u) => sum + parseFloat(u.total_coins_earned || 0), 0);

      // 3. User Engagement Metrics (Unique clickers)
      const getUniqueClickers = async (gteDate) => {
        const { data, error } = await supabaseAdmin
          .from('kash_ad_events')
          .select('user_id')
          .eq('event_type', 'click')
          .not('user_id', 'is', null)
          .gte('created_at', gteDate.toISOString());
        if (error) throw error;
        return new Set(filterOutDemoRows(data, demoUserIds).map((event) => event.user_id)).size;
      };

      const now = new Date();
      const startOfDay = new Date(now.setHours(0,0,0,0));
      const startOfWeek = new Date(new Date().setDate(now.getDate() - 7));
      const startOfMonth = new Date(new Date().setMonth(now.getMonth() - 1));

      const engagement = {
        daily: await getUniqueClickers(startOfDay),
        weekly: await getUniqueClickers(startOfWeek),
        monthly: await getUniqueClickers(startOfMonth),
        lifetime: realEarnersData.length // Users who have ever interacted
      };

      // 4. Leaderboards
      // Top Earners (Users who earn most from KashAds)
      const { data: topEarners } = await supabaseAdmin
        .from('kash_ads')
        .select('user_id, total_coins_earned, total_rewards_claimed, users:user_id(username, full_name)')
        .order('total_coins_earned', { ascending: false })
        .limit(50);
      const realTopEarners = filterOutDemoRows(topEarners, demoUserIds).slice(0, 5);

      // Top Advertisers (Users who spend most on ads)
      const { data: advertisersRaw } = await supabaseAdmin
        .from('kash_ad_submissions')
        .select('user_id, amount_paid, users:user_id(username, full_name)')
        .not('status', 'in', '("pending", "rejected")'); // Only account for actual revenue
      
      const advertiserMap = {};
      filterOutDemoRows(advertisersRaw, demoUserIds).forEach(ad => {
        const uid = ad.user_id;
        if (!advertiserMap[uid]) {
          advertiserMap[uid] = { 
            username: ad.users?.username || 'Unknown', 
            fullName: ad.users?.full_name || 'N/A',
            spend: 0, 
            count: 0 
          };
        }
        advertiserMap[uid].spend += parseFloat(ad.amount_paid);
        advertiserMap[uid].count += 1;
      });
      const topAdvertisers = Object.values(advertiserMap)
        .sort((a, b) => b.spend - a.spend)
        .slice(0, 5);

      // 5. Aggregate Daily Trend
      const aggregated = realPerformanceEvents.reduce((acc, curr) => {
        const date = new Date(curr.created_at).toISOString().slice(0, 10);
        if (!acc[date]) {
          acc[date] = { date, impressions: 0, clicks: 0 };
        }
        if (curr.event_type === 'impression') acc[date].impressions += 1;
        if (curr.event_type === 'click') acc[date].clicks += 1;
        return acc;
      }, {});

      const dailyStats = Object.values(aggregated);

      return res.status(200).json(formatResponse('success', 'Platform analytics fetched', {
        dailyStats,
        campaignRevenue: totalAdRevenue,
        earningPayables: totalUserPayables,
        activeCampaigns: realRevenueData.filter(ad => ad.status === 'active').length,
        engagement,
        leaderboards: {
          earners: realTopEarners,
          advertisers: topAdvertisers
        }
      }));
    } catch (error) {
       console.error('Admin Analytics Error:', error);
       return res.status(500).json(formatResponse('error', 'Failed to fetch analytics', error.message));
    }
  },

  /**
   * Admin: Update ad status (active, paused, etc)
   */
  adminUpdateAdStatus: async (req, res) => {
    const { ad_id, status } = req.body;
    try {
      const { data, error } = await supabaseAdmin
        .from('kash_ad_submissions')
        .update({ status, updated_at: new Date().toISOString() })
        .eq('id', ad_id)
        .select()
        .single();
      
      if (error) throw error;
      return res.status(200).json(formatResponse('success', `Ad status updated to ${status}`, data));
    } catch (error) {
      return res.status(500).json(formatResponse('error', 'Failed to update ad status', error.message));
    }
  },

  /**
   * Admin: Delete ad permanentely
   */
  adminDeleteAd: async (req, res) => {
    const { ad_id } = req.body;
    try {
      const { error } = await supabaseAdmin
        .from('kash_ad_submissions')
        .delete()
        .eq('id', ad_id);
      
      if (error) throw error;
      return res.status(200).json(formatResponse('success', 'Ad deleted successfully'));
    } catch (error) {
      return res.status(500).json(formatResponse('error', 'Failed to delete ad', error.message));
    }
  },

  /**
   * User: Update their own ad status (pause/resume)
   */
  updateMyAdStatus: async (req, res) => {
    const { ad_id, status } = req.body;
    const userId = req.user.id;
    try {
      // Only allow pausing/resuming 'active' or 'paused' ads.
      if (!['active', 'paused'].includes(status)) {
        return res.status(400).json(formatResponse('error', 'Invalid status. You can only pause or resume ads.'));
      }

      const { data: ad, error: adError } = await supabaseAdmin
        .from('kash_ad_submissions')
        .select('status, end_date')
        .eq('id', ad_id)
        .eq('user_id', userId)
        .single();

      if (adError || !ad) {
        return res.status(404).json(formatResponse('error', 'Ad not found'));
      }

      if (!['active', 'paused'].includes(ad.status)) {
        return res.status(400).json(formatResponse('error', `You cannot change status of a ${ad.status} ad.`));
      }

      // Check if expired
      if (new Date(ad.end_date) < new Date()) {
         return res.status(400).json(formatResponse('error', 'This ad campaign has expired and cannot be resumed.'));
      }

      const { data, error } = await supabaseAdmin
        .from('kash_ad_submissions')
        .update({ status, updated_at: new Date().toISOString() })
        .eq('id', ad_id)
        .eq('user_id', userId)
        .select()
        .single();
      
      if (error) throw error;
      return res.status(200).json(formatResponse('success', `Ad ${status} successfully`, data));
    } catch (error) {
       console.error('Error in updateMyAdStatus:', error);
      return res.status(500).json(formatResponse('error', 'Failed to update ad status', error.message));
    }
  }
};

module.exports = UserAdsController;
