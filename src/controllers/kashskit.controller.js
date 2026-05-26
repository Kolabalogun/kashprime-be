const { supabaseAdmin } = require('../services/supabase.service');
const path = require('path');
const { logActivity } = require('../utils/activityLogger');
const { v4: uuidv4 } = require('uuid');

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

// ==================== USER ENDPOINTS ====================

 

// Claim video reward
const claimVideoReward = async (req, res) => {
  try {
    const { video_id } = req.body;
    const userId = req.user.id;

    // Check if KashSkit is enabled
    const { data: enabledSetting } = await supabaseAdmin
      .from('platform_settings')
      .select('setting_value')
      .eq('setting_key', 'kashskit_enabled')
      .single();

    if (enabledSetting?.setting_value === 'false') {
      return res.status(403).json({
        status: 'error',
        message: 'KashSkit feature is currently disabled'
      });
    }

    // Get user tier
    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .select('user_tier')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found'
      });
    }

    // Check if video exists and is active
    const { data: video, error: videoError } = await supabaseAdmin
      .from('kashskit_videos')
      .select('*')
      .eq('id', video_id)
      .eq('is_active', true)
      .single();

    if (videoError || !video) {
      return res.status(404).json({
        status: 'error',
        message: 'Video not found or inactive'
      });
    }

    // Check if user already claimed this video
    const { data: existingClaim } = await supabaseAdmin
      .from('kashskit_user_claims')
      .select('id')
      .eq('user_id', userId)
      .eq('video_id', video_id)
      .single();

    if (existingClaim) {
      return res.status(409).json({
        status: 'error',
        message: 'You have already claimed reward for this video'
      });
    }

    // Check daily limit
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const { data: todayClaims } = await supabaseAdmin
      .from('kashskit_user_claims')
      .select('id')
      .eq('user_id', userId)
      .gte('claimed_at', todayStart.toISOString());

    // Get daily limits from settings
    const isPro = user.user_tier === 'Pro';
    const limitKey = 'kashskit_daily_limit_free';

    const { data: limitSetting } = await supabaseAdmin
      .from('platform_settings')
      .select('setting_value')
      .eq('setting_key', limitKey)
      .single();

    const dailyLimit = parseInt(limitSetting?.setting_value || 2);

    if (!isPro && todayClaims && todayClaims.length >= dailyLimit) {
      return res.status(403).json({
        status: 'error',
        message: `Daily claim limit of ${dailyLimit} videos reached. Upgrade to Pro for unlimited access!`,
        data: {
          restriction_reason: 'limit_reached',
          daily_limit: dailyLimit,
          claims_today: todayClaims.length,
          limit_remaining: 0
        }
      });
    }

    // Get reward amount based on user tier rigidly mapped
    const rewardAmount = isPro ? 1000 : 500;

    // Create claim record
    const { data: claim, error: claimError } = await supabaseAdmin
      .from('kashskit_user_claims')
      .insert({
        user_id: userId,
        video_id: video_id,
        reward_amount: rewardAmount
      })
      .select()
      .single();

    if (claimError) {
      if (claimError.code === '23505') {
        return res.status(409).json({
          status: 'error',
          message: 'You have already claimed reward for this video'
        });
      }
      throw claimError;
    }

    // Update user's coins_balance
    const { data: wallet } = await supabaseAdmin
      .from('wallets')
      .select('coins_balance')
      .eq('user_id', userId)
      .single();

    const newBalance = parseFloat(wallet?.coins_balance || 0) + rewardAmount;

    const { error: walletError } = await supabaseAdmin
      .from('wallets')
      .update({ coins_balance: newBalance })
      .eq('user_id', userId);

    if (walletError) throw walletError;

    // Update video statistics
    await supabaseAdmin
      .from('kashskit_videos')
      .update({
        claims_count: video.claims_count + 1,
        views_count: video.views_count + 1
      })
      .eq('id', video_id);

    // Create transaction record
    await supabaseAdmin
      .from('transactions')
      .insert({
        user_id: userId,
        transaction_type: 'reward',
        balance_type: 'coins_balance',
        amount: rewardAmount,
        currency: 'NGN',
        status: 'completed',
        description: `KashSkit reward - ${video.skit_title}`,
        reference: `KASHSKIT-${Date.now()}-${userId.slice(-4).toUpperCase()}`,
        metadata: {
          video_id: video_id,
          video_title: video.skit_title,
          user_tier: user.user_tier
        }
      });
    // Log Activity
    await logActivity(userId, 'kashskit_earn', {
       video_id: video_id,
       video_title: video.skit_title,
       reward_amount: rewardAmount
    }, req);

    res.status(200).json({
      status: 'success',
      message: 'Video reward claimed successfully',
      data: {
        claim: {
          id: claim.id,
          reward_amount: rewardAmount,
          claimed_at: claim.claimed_at
        },
        video: {
          id: video.id,
          title: video.skit_title,
          creator: video.creator
        },
        new_coins_balance: newBalance,
        remaining_claims_today: dailyLimit - (todayClaims?.length || 0) - 1
      }
    });

  } catch (error) {
    console.error('Claim video reward error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};

// Get available videos
const getAvailableVideos = async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const userId = req.user.id;
    const offset = (page - 1) * limit;

    // Check if KashSkit is enabled
    const { data: enabledSetting } = await supabaseAdmin
      .from('platform_settings')
      .select('setting_value')
      .eq('setting_key', 'kashskit_enabled')
      .single();

    if (enabledSetting?.setting_value === 'false') {
      return res.status(403).json({
        status: 'error',
        message: 'KashSkit feature is currently disabled'
      });
    }

    // Get user tier for daily limit
    const { data: user } = await supabaseAdmin
      .from('users')
      .select('user_tier')
      .eq('id', userId)
      .single();

    const isPaidUser = ['Amateur', 'Pro'].includes(user?.user_tier);

    // Get user's claims for today
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const { data: todayClaims, error: claimsError } = await supabaseAdmin
      .from('kashskit_user_claims')
      .select('video_id')
      .eq('user_id', userId)
      .gte('claimed_at', todayStart.toISOString());

    if (claimsError) throw claimsError;

    const claimedVideoIds = todayClaims?.map(c => c.video_id) || [];

    // Get active videos excluding already claimed ones
    let query = supabaseAdmin
      .from('kashskit_videos')
      .select('*', { count: 'exact' })
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .range(offset, offset + parseInt(limit) - 1);

    if (claimedVideoIds.length > 0) {
      query = query.not('id', 'in', `(${claimedVideoIds.join(',')})`);
    }

    const { data: videos, error: videoError, count } = await query;
    if (videoError) throw videoError;

    // Get daily limit from settings
    const limitKey = isPaidUser ? 'kashskit_daily_limit_paid' : 'kashskit_daily_limit_free';

    const { data: limitSetting } = await supabaseAdmin
      .from('platform_settings')
      .select('setting_value')
      .eq('setting_key', limitKey)
      .single();

    const dailyLimit = parseInt(limitSetting?.setting_value || (isPaidUser ? 5 : 3));
    const claimsToday = todayClaims?.length || 0;

    res.status(200).json({
      status: 'success',
      message: 'Videos retrieved successfully',
      data: {
        videos,
        daily_stats: {
          claims_today: claimsToday,
          daily_limit: dailyLimit,
          remaining_claims: Math.max(0, dailyLimit - claimsToday),
          can_claim_more: claimsToday < dailyLimit
        },
        pagination: {
          current_page: parseInt(page),
          total_pages: Math.ceil((count || 0) / limit),
          total_videos: count || 0,
          has_next: offset + limit < (count || 0),
          has_prev: page > 1,
          limit: parseInt(limit)
        }
      }
    });

  } catch (error) {
    console.error('Get available videos error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};

const getUserClaimHistory = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const userId = req.user.id;
    const offset = (page - 1) * limit;

    const { data: claims, error, count } = await supabaseAdmin
      .from('kashskit_user_claims')
      .select(`
        id, reward_amount, claimed_at,
        kashskit_videos (
          id, skit_title, creator, thumbnail_url
        )
      `, { count: 'exact' })
      .eq('user_id', userId)
      .order('claimed_at', { ascending: false })
      .range(offset, offset + parseInt(limit) - 1);

    if (error) throw error;

    res.status(200).json({
      status: 'success',
      message: 'Claim history retrieved successfully',
      data: {
        claims,
        pagination: {
          current_page: parseInt(page),
          total_pages: Math.ceil((count || 0) / limit),
          total_claims: count || 0,
          has_next: offset + limit < (count || 0),
          has_prev: page > 1,
          limit: parseInt(limit)
        }
      }
    });

  } catch (error) {
    console.error('Get user claim history error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};

// ==================== ADMIN ENDPOINTS ====================

const uploadVideo = async (req, res) => {
  try {
    const { skit_title, creator, external_link } = req.body;
    const adminId = req.user.id;

    if (!req.file) {
      return res.status(400).json({
        status: 'error',
        message: 'Video file is required'
      });
    }

    // Generate unique filename
    const fileExt = path.extname(req.file.originalname);
    const fileName = `kashskit/${uuidv4()}${fileExt}`;

    // Upload to Supabase Storage
    const { data: uploadData, error: uploadError } = await supabaseAdmin
      .storage
      .from('kashprime')
      .upload(fileName, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false
      });

    if (uploadError) {
      console.error('Upload error:', uploadError);
      return res.status(500).json({
        status: 'error',
        message: 'Failed to upload video'
      });
    }

    // Get public URL
    const { data: urlData } = supabaseAdmin
      .storage
      .from('kashprime')
      .getPublicUrl(fileName);

    const videoUrl = urlData.publicUrl;

    // Save video record to database
    const { data: video, error: dbError } = await supabaseAdmin
      .from('kashskit_videos')
      .insert({
        skit_title,
        creator,
        external_link: external_link || null,
        video_url: videoUrl,
        uploaded_by: adminId
      })
      .select()
      .single();

    if (dbError) throw dbError;

    // Log admin activity
    await supabaseAdmin
      .from('admin_activities')
      .insert({
        admin_id: adminId,
        activity_type: 'kashskit_video_uploaded',
        description: `Uploaded KashSkit video: ${skit_title}`,
        metadata: { video_id: video.id, title: skit_title, creator }
      });

    res.status(201).json({
      status: 'success',
      message: 'Video uploaded successfully',
      data: { video }
    });

  } catch (error) {
    console.error('Upload video error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};

const getAllVideos = async (req, res) => {
  try {
    const demoUserIds = await getDemoUserIds();
    const {
      page = 1,
      limit = 20,
      search = '',
      is_active = ''
    } = req.query;

    const offset = (page - 1) * limit;

    let query = supabaseAdmin
      .from('kashskit_videos')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + parseInt(limit) - 1);

    if (search) {
      query = query.or(`skit_title.ilike.%${search}%,creator.ilike.%${search}%`);
    }

    if (is_active !== '') {
      query = query.eq('is_active', is_active === true);
    }

    const { data: videos, error, count } = await query;
    if (error) throw error;

    const { data: allVideos } = await supabaseAdmin
      .from('kashskit_videos')
      .select('id, is_active');

    const { data: allClaims } = await supabaseAdmin
      .from('kashskit_user_claims')
      .select('video_id, user_id, reward_amount');

    const realClaims = filterOutDemoRows(allClaims, demoUserIds);
    const claimsByVideo = realClaims.reduce((acc, claim) => {
      if (!acc[claim.video_id]) {
        acc[claim.video_id] = { claims_count: 0, rewards: 0 };
      }
      acc[claim.video_id].claims_count += 1;
      acc[claim.video_id].rewards += parseFloat(claim.reward_amount || 0);
      return acc;
    }, {});

    const videosWithoutDemoStats = (videos || []).map((video) => {
      const realStats = claimsByVideo[video.id] || { claims_count: 0 };
      return {
        ...video,
        claims_count: realStats.claims_count,
        views_count: realStats.claims_count
      };
    });

    res.status(200).json({
      status: 'success',
      message: 'Videos retrieved successfully',
      data: {
        videos: videosWithoutDemoStats,
        overview: {
          total_videos: allVideos?.length || count || 0,
          active_videos: (allVideos || []).filter((video) => video.is_active).length,
          total_claims: realClaims.length,
          total_rewards_distributed: realClaims.reduce((sum, claim) => sum + parseFloat(claim.reward_amount || 0), 0)
        },
        pagination: {
          current_page: parseInt(page),
          total_pages: Math.ceil((count || 0) / limit),
          total_videos: count || 0,
          has_next: offset + limit < (count || 0),
          has_prev: page > 1,
          limit: parseInt(limit)
        }
      }
    });

  } catch (error) {
    console.error('Get all videos error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};

const getVideoDetails = async (req, res) => {
  try {
    const demoUserIds = await getDemoUserIds();
    const { videoId } = req.params;

    const { data: video, error: videoError } = await supabaseAdmin
      .from('kashskit_videos')
      .select('*')
      .eq('id', videoId)
      .single();

    if (videoError || !video) {
      return res.status(404).json({
        status: 'error',
        message: 'Video not found'
      });
    }

    // Get users who claimed this video
    const { data: claims } = await supabaseAdmin
      .from('kashskit_user_claims')
      .select(`
        id, user_id, reward_amount, claimed_at,
        users (id, username, full_name, user_tier)
      `)
      .eq('video_id', videoId)
      .order('claimed_at', { ascending: false });

    const realClaims = filterOutDemoRows(claims, demoUserIds);

    res.status(200).json({
      status: 'success',
      message: 'Video details retrieved successfully',
      data: {
        video: {
          ...video,
          claims_count: realClaims.length,
          views_count: realClaims.length
        },
        claims: (realClaims || []).slice(0, 50),
        statistics: {
          total_claims: realClaims.length,
          total_views: realClaims.length,
          total_rewards_distributed: realClaims.reduce((sum, claim) => sum + parseFloat(claim.reward_amount || 0), 0)
        }
      }
    });

  } catch (error) {
    console.error('Get video details error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};

const deleteVideo = async (req, res) => {
  try {
    const { videoId } = req.params;
    const adminId = req.user.id;

    // Get video details
    const { data: video, error: videoError } = await supabaseAdmin
      .from('kashskit_videos')
      .select('*')
      .eq('id', videoId)
      .single();

    if (videoError || !video) {
      return res.status(404).json({
        status: 'error',
        message: 'Video not found'
      });
    }

    // Delete video file from storage
    if (video.video_url) {
      const urlParts = video.video_url.split('/lumikash/');
      if (urlParts.length > 1) {
        const filePath = urlParts[1];
        await supabaseAdmin
          .storage
          .from('kashprime')
          .remove([filePath]);
      }
    }

    // Delete video record
    const { error: deleteError } = await supabaseAdmin
      .from('kashskit_videos')
      .delete()
      .eq('id', videoId);

    if (deleteError) throw deleteError;

    // Log admin activity
    await supabaseAdmin
      .from('admin_activities')
      .insert({
        admin_id: adminId,
        activity_type: 'kashskit_video_deleted',
        description: `Deleted KashSkit video: ${video.skit_title}`,
        metadata: { video_id: videoId, title: video.skit_title }
      });

    res.status(200).json({
      status: 'success',
      message: 'Video deleted successfully'
    });

  } catch (error) {
    console.error('Delete video error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};

 

 

const toggleVideoStatus = async (req, res) => {
  try {
    const { videoId } = req.params;
    const { is_active } = req.body;

    if (typeof is_active !== 'boolean') {
      return res.status(400).json({ status: 'error', message: 'is_active must be a boolean' });
    }

    const { data, error } = await supabaseAdmin
      .from('kashskit_videos')
      .update({ is_active, updated_at: new Date().toISOString() })
      .eq('id', videoId)
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ status: 'error', message: 'Video not found' });
    }

    return res.status(200).json({
      status: 'success',
      message: `Video ${is_active ? 'activated' : 'deactivated'} successfully`,
      data: { video: data }
    });
  } catch (error) {
    console.error('Toggle video status error:', error);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

const getDailyStatus = async (req, res) => {
  try {
    const userId = req.user.id;

    // Check if KashSkit is enabled
    const { data: enabledSetting } = await supabaseAdmin
      .from('platform_settings')
      .select('setting_value')
      .eq('setting_key', 'kashskit_enabled')
      .single();

    if (enabledSetting?.setting_value === 'false') {
      return res.status(403).json({
        status: 'error',
        message: 'KashSkit feature is currently disabled'
      });
    }

    const { data: user } = await supabaseAdmin
      .from('users')
      .select('user_tier')
      .eq('id', userId)
      .single();

    const isPro = user?.user_tier === 'Pro';

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const { data: todayClaims } = await supabaseAdmin
      .from('kashskit_user_claims')
      .select('video_id')
      .eq('user_id', userId)
      .gte('claimed_at', todayStart.toISOString());

    const limitKey = 'kashskit_daily_limit_free';

    const { data: limitSetting } = await supabaseAdmin
      .from('platform_settings')
      .select('setting_value')
      .eq('setting_key', limitKey)
      .single();

    const dailyLimit = parseInt(limitSetting?.setting_value || 2);
    const rewardAmount = isPro ? 1000 : 500;
    const claimsToday = todayClaims?.length || 0;
    const remainingClaims = isPro ? null : Math.max(0, dailyLimit - claimsToday);

    return res.status(200).json({
      status: 'success',
      message: 'Daily status retrieved',
      data: {
        claims_today: claimsToday,
        daily_limit: isPro ? 'Unlimited' : dailyLimit,
        remaining_claims: isPro ? 'Unlimited' : remainingClaims,
        limit_remaining: isPro ? 'Unlimited' : remainingClaims,
        can_claim_more: isPro || claimsToday < dailyLimit,
        reward_per_video: rewardAmount,
        restriction_reason: (!isPro && claimsToday >= dailyLimit) ? 'limit_reached' : null
      }
    });
  } catch (error) {
    console.error('Get daily status error:', error);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

module.exports = {
  claimVideoReward,
  getAvailableVideos,
  getUserClaimHistory,
  getAllVideos,
  getVideoDetails,
  deleteVideo,
  uploadVideo,
  toggleVideoStatus,
  getDailyStatus,
};
