const { supabaseAdmin } = require("../services/supabase.service");
const { validationResult } = require("express-validator");
const { logActivity } = require("../utils/activityLogger");
const messages = require("../utils/constants/kashfeed");

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

// Get daily status for sponsored posts
const getDailyStatus = async (req, res) => {
  try {
    const userId = req.user.id;

    // Check if sponsored posts enabled
    const { data: enabledSetting } = await supabaseAdmin
      .from('platform_settings')
      .select('setting_value')
      .eq('setting_key', 'sponsored_enabled')
      .single();

    if (enabledSetting?.setting_value === 'false') {
      return res.status(403).json({
        status: 'error',
        message: 'Sponsored Posts feature is currently disabled'
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

    // Get daily limits from platform settings
    const isPro = user.user_tier === 'Pro';
    const limitKey = 'sponsored_daily_limit_free';

    const { data: limitSetting } = await supabaseAdmin
      .from('platform_settings')
      .select('setting_value')
      .eq('setting_key', limitKey)
      .single();

    // Default limit is 2 for free users. Pro users bypass this check entirely.
    const dailyLimit = parseInt(limitSetting?.setting_value || 2);
    const rewardAmount = isPro ? 1000 : 500;

    // Get today's engagements
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const { data: todayEngagements, error: engagementError } = await supabaseAdmin
      .from('sponsored_engagements')
      .select('id, post_id, reward_amount, created_at')
      .eq('user_id', userId)
      .gte('created_at', todayStart.toISOString());

    if (engagementError) {
      console.error('Engagement fetch error:', engagementError);
      return res.status(500).json({
        status: 'error',
        message: 'Failed to fetch engagement data'
      });
    }

    const engagedCount = todayEngagements?.length || 0;
    const remainingEngagements = isPro ? null : Math.max(0, dailyLimit - engagedCount);
    const totalEarnedToday = todayEngagements?.reduce((sum, e) => sum + parseFloat(e.reward_amount), 0) || 0;

    // Get list of post IDs user has already engaged with (all time)
    const { data: allEngagements } = await supabaseAdmin
      .from('sponsored_engagements')
      .select('post_id')
      .eq('user_id', userId);

    const engagedPostIds = allEngagements?.map(e => e.post_id) || [];

    // Calculate next reset time (midnight)
    const nextResetTime = new Date();
    nextResetTime.setHours(24, 0, 0, 0);

    res.json({
      status: 'success',
      message: 'Daily status retrieved successfully',
      data: {
        user_tier: user.user_tier,
        daily_limit: isPro ? 'Unlimited' : dailyLimit,
        engaged_today: engagedCount,
        remaining_engagements: isPro ? 'Unlimited' : remainingEngagements,
        limit_remaining: isPro ? 'Unlimited' : remainingEngagements,
        reward_per_post: rewardAmount,
        total_earned_today: totalEarnedToday,
        potential_earnings: isPro ? 'Unlimited' : (remainingEngagements * rewardAmount),
        can_engage: isPro || remainingEngagements > 0,
        engaged_post_ids: engagedPostIds,
        next_reset_time: nextResetTime.toISOString(),
        today_engagements: todayEngagements || [],
        restriction_reason: (!isPro && remainingEngagements <= 0) ? 'limit_reached' : null
      }
    });

  } catch (error) {
    console.error('Get daily status error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};

// Create new sponsored post (Admin only)
const createPost = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        status: "error",
        message: messages.ERROR.VALIDATION_ERROR,
        data: { errors: errors.array() },
      });
    }

    const adminId = req.user.id;

    const { data, error } = await supabaseAdmin
      .from("sponsored_posts")
      .insert([
        {
          admin_id: adminId,
          title: req.body.title,
          content: req.body.content,
          featured_image: req.file ? req.file.path : null,
          link1: req.body.link1 || null,
          link2: req.body.link2 || null,
          status: "published",
          is_published: true,
          published_at: new Date().toISOString(),
        },
      ])
      .select(
        `
        *,
        admin_user:admin_id (
          id, username, full_name, profile_picture
        )
      `
      )
      .single();

    if (error) {
      console.error("Database error:", error);
      return res.status(500).json({
        status: "error",
        message: messages.ERROR.SERVER_ERROR,
      });
    }

    await supabaseAdmin.from("admin_activities").insert([
      {
        admin_id: adminId,
        activity_type: "sponsored_post_create",
        description: `Created sponsored post: ${data.title}`,
        metadata: {
          post_id: data.id,
          title: data.title,
        },
      },
    ]);

    res.status(201).json({
      status: "success",
      message: "Sponsored post created successfully",
      data: { post: data },
    });
  } catch (error) {
    console.error("Create sponsored post error:", error);
    res.status(500).json({
      status: "error",
      message: messages.ERROR.SERVER_ERROR,
    });
  }
};

// Get all sponsored posts (Admin management)
const getAllPosts = async (req, res) => {
  try {
    const demoUserIds = await getDemoUserIds();
    const { page = 1, limit = 20, search } = req.query;
    const offset = (page - 1) * limit;

    let query = supabaseAdmin
      .from("sponsored_posts")
      .select(
        `
        *,
        admin_user:admin_id (
          id, username, full_name, profile_picture
        )
      `,
        { count: "exact" }
      )
      .order("created_at", { ascending: false });

    if (search) {
      query = query.or(`title.ilike.%${search}%, content.ilike.%${search}%`);
    }

    query = query.range(offset, offset + limit - 1);
    const { data, error, count } = await query;

    if (error) {
      console.error("Database error:", error);
      return res.status(500).json({
        status: "error",
        message: messages.ERROR.SERVER_ERROR,
      });
    }

    const { data: allPosts } = await supabaseAdmin
      .from("sponsored_posts")
      .select("id, is_published, status");

    const { data: allEngagements } = await supabaseAdmin
      .from("sponsored_engagements")
      .select("post_id, user_id, reward_amount");

    const realEngagements = filterOutDemoRows(allEngagements, demoUserIds);
    const engagementByPost = realEngagements.reduce((acc, engagement) => {
      if (!acc[engagement.post_id]) {
        acc[engagement.post_id] = { count: 0, rewards: 0 };
      }
      acc[engagement.post_id].count += 1;
      acc[engagement.post_id].rewards += parseFloat(engagement.reward_amount || 0);
      return acc;
    }, {});

    const postsWithoutDemoStats = (data || []).map((post) => {
      const realStats = engagementByPost[post.id] || { count: 0 };
      return {
        ...post,
        likes_count: realStats.count,
        engagements_count: realStats.count
      };
    });

    res.json({
      status: "success",
      message: "Sponsored posts retrieved successfully",
      data: {
        posts: postsWithoutDemoStats,
        overview: {
          total_posts: allPosts?.length || count || 0,
          active_posts: (allPosts || []).filter((post) => post.is_published || post.status === 'published').length,
          total_engagements: realEngagements.length,
          total_rewards: realEngagements.reduce((sum, engagement) => sum + parseFloat(engagement.reward_amount || 0), 0)
        },
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: count,
          has_more: count > offset + limit,
        },
      },
    });
  } catch (error) {
    console.error("Get all sponsored posts error:", error);
    res.status(500).json({
      status: "error",
      message: messages.ERROR.SERVER_ERROR,
    });
  }
};

// Get published sponsored posts (Public access)
const getPublishedPosts = async (req, res) => {
  try {
    const { page = 1, limit = 10, search, sort = "latest" } = req.query;
    const offset = (page - 1) * limit;

    let query = supabaseAdmin
      .from("sponsored_posts")
      .select(
        `
        *,
        admin_user:admin_id (
          id, username, full_name, profile_picture
        )
      `,
        { count: "exact" }
      )
      .eq("status", "published")
      .eq("is_published", true);

    if (search) {
      query = query.or(`title.ilike.%${search}%, content.ilike.%${search}%`);
    }

    switch (sort) {
      case "popular":
        query = query.order("view_count", { ascending: false });
        break;
      case "engagement":
        query = query.order("engagement_count", { ascending: false });
        break;
      default:
        query = query.order("published_at", { ascending: false });
    }

    query = query.range(offset, offset + limit - 1);
    const { data, error, count } = await query;

    if (error) {
      console.error("Database error:", error);
      return res.status(500).json({
        status: "error",
        message: messages.ERROR.SERVER_ERROR,
      });
    }

    res.json({
      status: "success",
      message: "Sponsored posts retrieved successfully",
      data: {
        posts: data,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: count,
          has_more: count > offset + limit,
        },
      },
    });
  } catch (error) {
    console.error("Get published sponsored posts error:", error);
    res.status(500).json({
      status: "error",
      message: messages.ERROR.SERVER_ERROR,
    });
  }
};

// Get sponsored post by ID
const getPostById = async (req, res) => {
  try {
    const postId = req.params.postId;

    const { data, error } = await supabaseAdmin
      .from("sponsored_posts")
      .select(
        `
        *,
        admin_user:admin_id (
          id, username, full_name, profile_picture
        )
      `
      )
      .eq("id", postId)
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        return res.status(404).json({
          status: "error",
          message: "Sponsored post not found",
        });
      }

      console.error("Database error:", error);
      return res.status(500).json({
        status: "error",
        message: messages.ERROR.SERVER_ERROR,
      });
    }

    await supabaseAdmin
      .from("sponsored_posts")
      .update({ view_count: (data.view_count || 0) + 1 })
      .eq("id", postId);

    res.json({
      status: "success",
      message: "Sponsored post retrieved successfully",
      data: {
        post: { ...data, view_count: (data.view_count || 0) + 1 },
      },
    });
  } catch (error) {
    console.error("Get sponsored post by ID error:", error);
    res.status(500).json({
      status: "error",
      message: messages.ERROR.SERVER_ERROR,
    });
  }
};

// Update sponsored post (Admin only)
const updatePost = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        status: "error",
        message: messages.ERROR.VALIDATION_ERROR,
        data: { errors: errors.array() },
      });
    }

    const { id } = req.params;
    const adminId = req.user.id;

    const cleanData = Object.fromEntries(
      Object.entries(req.body).filter(([_, v]) => v !== undefined)
    );

    if (req.file) {
      cleanData.featured_image = req.file.path;
    }

    cleanData.updated_at = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from("sponsored_posts")
      .update(cleanData)
      .eq("id", id)
      .select(
        `
        *,
        admin_user:admin_id (
          id, username, full_name, profile_picture
        )
      `
      )
      .single();

    if (error || !data) {
      return res.status(404).json({
        status: "error",
        message: "Sponsored post not found",
      });
    }

    await supabaseAdmin.from("admin_activities").insert([
      {
        admin_id: adminId,
        activity_type: "sponsored_post_update",
        description: `Updated sponsored post: ${data.title}`,
        metadata: {
          post_id: id,
          changes: cleanData,
        },
      },
    ]);

    res.json({
      status: "success",
      message: "Sponsored post updated successfully",
      data: { post: data },
    });
  } catch (error) {
    console.error("Update sponsored post error:", error);
    res.status(500).json({
      status: "error",
      message: messages.ERROR.SERVER_ERROR,
    });
  }
};

// Delete sponsored post (Admin only)
const deletePost = async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.user.id;

    const { data: post } = await supabaseAdmin
      .from("sponsored_posts")
      .select("featured_image, title")
      .eq("id", id)
      .single();

    const { data, error } = await supabaseAdmin
      .from("sponsored_posts")
      .delete()
      .eq("id", id)
      .select("id")
      .single();

    if (error || !data) {
      return res.status(404).json({
        status: "error",
        message: "Sponsored post not found",
      });
    }

    if (post?.featured_image && post.featured_image.includes("supabase")) {
      const imagePath = post.featured_image.split("/").pop();
      await supabaseAdmin.storage
        .from("lumikash")
        .remove([`sponsored/${imagePath}`]);
    }

    await supabaseAdmin.from("admin_activities").insert([
      {
        admin_id: adminId,
        activity_type: "sponsored_post_delete",
        description: `Deleted sponsored post: ${post?.title || "Unknown"}`,
        metadata: {
          post_id: id,
          title: post?.title,
        },
      },
    ]);

    res.json({
      status: "success",
      message: "Sponsored post deleted successfully",
    });
  } catch (error) {
    console.error("Delete sponsored post error:", error);
    res.status(500).json({
      status: "error",
      message: messages.ERROR.SERVER_ERROR,
    });
  }
};

// Engage with sponsored post (reward coins)
const engagePost = async (req, res) => {
  try {
    const { postId } = req.params;
    const userId = req.user.id;

    // Check if sponsored posts enabled
    const { data: enabledSetting } = await supabaseAdmin
      .from('platform_settings')
      .select('setting_value')
      .eq('setting_key', 'sponsored_enabled')
      .single();

    if (enabledSetting?.setting_value === 'false') {
      return res.status(403).json({
        status: 'error',
        message: 'Sponsored Posts feature is currently disabled'
      });
    }

    // Check if sponsored post exists and is published
    const { data: post, error: postError } = await supabaseAdmin
      .from('sponsored_posts')
      .select('id, admin_id, title')
      .eq('id', postId)
      .eq('status', 'published')
      .eq('is_published', true)
      .single();

    if (postError || !post) {
      return res.status(404).json({
        status: 'error',
        message: 'Sponsored post not found or not published'
      });
    }

    // Check if user already engaged with this specific post
    const { data: existingEngagement } = await supabaseAdmin
      .from('sponsored_engagements')
      .select('id, created_at')
      .eq('user_id', userId)
      .eq('post_id', postId)
      .single();

    if (existingEngagement) {
      return res.status(409).json({
        status: 'error',
        message: 'You have already earned from this sponsored post'
      });
    }

    // Get user tier
    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .select('user_tier')
      .eq('id', userId)
      .single();

    if (userError) {
      console.error('User fetch error:', userError);
      return res.status(500).json({
        status: 'error',
        message: 'Internal server error'
      });
    }

    // Get daily limit from platform settings
    const isPro = user.user_tier === 'Pro';
    const limitKey = 'sponsored_daily_limit_free';

    const { data: limitSetting } = await supabaseAdmin
      .from('platform_settings')
      .select('setting_value')
      .eq('setting_key', limitKey)
      .single();

    const dailyLimit = parseInt(limitSetting?.setting_value || 2);

    // Check if user has reached daily limit
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const { data: todayEngagements, count: todayCount } = await supabaseAdmin
      .from('sponsored_engagements')
      .select('id', { count: 'exact' })
      .eq('user_id', userId)
      .gte('created_at', todayStart.toISOString());

    if (!isPro && (todayCount || 0) >= dailyLimit) {
      return res.status(403).json({
        status: 'error',
        message: `You have reached your daily limit of ${dailyLimit} sponsored posts. Upgrade to Pro for unlimited access!`,
        data: {
          restriction_reason: 'limit_reached',
          daily_limit: dailyLimit,
          engaged_today: todayCount,
          limit_remaining: 0,
          next_reset_time: new Date(new Date().setHours(24, 0, 0, 0)).toISOString()
        }
      });
    }

    // Get reward amount Based on user Tier instead of settings (To keep it strict)
    const rewardAmount = isPro ? 1000 : 500;

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

    if (walletError) {
      console.error('Wallet update error:', walletError);
      return res.status(500).json({
        status: 'error',
        message: 'Failed to update wallet balance'
      });
    }

    // Record engagement
    const { data: engagement, error: engagementError } = await supabaseAdmin
      .from('sponsored_engagements')
      .insert([
        {
          user_id: userId,
          post_id: postId,
          reward_amount: rewardAmount
        }
      ])
      .select()
      .single();

    if (engagementError) {
      console.error('Engagement record error:', engagementError);
      await supabaseAdmin
        .from('wallets')
        .update({ coins_balance: parseFloat(wallet?.coins_balance || 0) })
        .eq('user_id', userId);
      
      return res.status(500).json({
        status: 'error',
        message: 'Failed to record engagement'
      });
    }

    // Update engagement count on post
    await supabaseAdmin
      .from('sponsored_posts')
      .update({ engagement_count: (post.engagement_count || 0) + 1 })
      .eq('id', postId);

    // Log transaction
    const referenceId = `SPONSORED_${Date.now()}_${userId.slice(-4).toUpperCase()}`;
    await supabaseAdmin.from('transactions').insert([
      {
        user_id: userId,
        transaction_type: 'reward',
        balance_type: 'coins_balance',
        amount: rewardAmount,
        status: 'completed',
        description: `Sponsored post reward - ${post.title}`,
        reference: referenceId,
        metadata: {
          post_id: postId,
          post_title: post.title
        }
      }
    ]);
    // Log Activity
    await logActivity(userId, 'sponsored_post_earn', {
       post_id: postId,
       post_title: post.title,
       amount: rewardAmount,
       before_balance: parseFloat(wallet?.coins_balance || 0),
       after_balance: newBalance,
       reference_id: referenceId,
       status: 'success'
    }, req);

    const newEngagedCount = (todayCount || 0) + 1;
    const remainingEngagements = dailyLimit - newEngagedCount;

    res.status(200).json({
      status: 'success',
      message: `Congratulations! You earned ₦${rewardAmount.toLocaleString()} coins`,
      data: {
        reward_amount: rewardAmount,
        new_coins_balance: newBalance,
        engagement: {
          id: engagement.id,
          post_id: postId,
          claimed_at: engagement.created_at
        },
        daily_status: {
          daily_limit: dailyLimit,
          engaged_today: newEngagedCount,
          remaining_engagements: remainingEngagements,
          daily_limit_reached: remainingEngagements <= 0
        },
        next_reset_time: new Date(new Date().setHours(24, 0, 0, 0)).toISOString()
      }
    });
  } catch (error) {
    console.error('Engage sponsored post error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};

// Check if user can engage with a specific post
const canEngagePost = async (req, res) => {
  try {
    const { postId } = req.params;
    const userId = req.user.id;

    // Check if post exists
    const { data: post, error: postError } = await supabaseAdmin
      .from('sponsored_posts')
      .select('id, title')
      .eq('id', postId)
      .eq('status', 'published')
      .eq('is_published', true)
      .single();

    if (postError || !post) {
      return res.status(404).json({
        status: 'error',
        message: 'Sponsored post not found'
      });
    }

    // Check if already engaged with this post
    const { data: existingEngagement } = await supabaseAdmin
      .from('sponsored_engagements')
      .select('id, created_at, reward_amount')
      .eq('user_id', userId)
      .eq('post_id', postId)
      .single();

    if (existingEngagement) {
      return res.json({
        status: 'success',
        data: {
          can_engage: false,
          reason: 'already_engaged',
          message: 'You have already earned from this post',
          engaged_at: existingEngagement.created_at,
          reward_earned: existingEngagement.reward_amount
        }
      });
    }

    // Get user tier and check daily limit
    const { data: user } = await supabaseAdmin
      .from('users')
      .select('user_tier')
      .eq('id', userId)
      .single();

    const isPaidUser = ['Amateur', 'Pro'].includes(user?.user_tier);
    const limitKey = isPaidUser ? 'sponsored_daily_limit_paid' : 'sponsored_daily_limit_free';

    const { data: limitSetting } = await supabaseAdmin
      .from('platform_settings')
      .select('setting_value')
      .eq('setting_key', limitKey)
      .single();

    const dailyLimit = parseInt(limitSetting?.setting_value || (isPaidUser ? 5 : 3));

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const { count: todayCount } = await supabaseAdmin
      .from('sponsored_engagements')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('created_at', todayStart.toISOString());

    if ((todayCount || 0) >= dailyLimit) {
      return res.json({
        status: 'success',
        data: {
          can_engage: false,
          reason: 'daily_limit_reached',
          message: `Daily limit of ${dailyLimit} posts reached`,
          daily_limit: dailyLimit,
          engaged_today: todayCount,
          next_reset_time: new Date(new Date().setHours(24, 0, 0, 0)).toISOString()
        }
      });
    }

    res.json({
      status: 'success',
      data: {
        can_engage: true,
        daily_limit: dailyLimit,
        engaged_today: todayCount || 0,
        remaining_engagements: dailyLimit - (todayCount || 0)
      }
    });

  } catch (error) {
    console.error('Can engage post error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};

// Toggle post status (Admin only)
const togglePostStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { is_published } = req.body;
    const adminId = req.user.id;

    if (typeof is_published !== 'boolean') {
      return res.status(400).json({
        status: "error",
        message: "is_published must be a boolean",
      });
    }

    const { data, error } = await supabaseAdmin
      .from("sponsored_posts")
      .update({
        is_published,
        status: is_published ? "published" : "draft",
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({
        status: "error",
        message: "Sponsored post not found",
      });
    }

    await supabaseAdmin.from("admin_activities").insert([
      {
        admin_id: adminId,
        activity_type: "sponsored_post_toggle",
        description: `${is_published ? "Published" : "Unpublished"} sponsored post: ${data.title}`,
        metadata: {
          post_id: id,
          is_published,
        },
      },
    ]);

    res.json({
      status: "success",
      message: `Sponsored post ${is_published ? "published" : "drafted"} successfully`,
      data: { post: data },
    });
  } catch (error) {
    console.error("Toggle sponsored post error:", error);
    res.status(500).json({
      status: "error",
      message: messages.ERROR.SERVER_ERROR,
    });
  }
};

module.exports = {
  getDailyStatus,
  createPost,
  getAllPosts,
  getPublishedPosts,
  getPostById,
  updatePost,
  deletePost,
  engagePost,
  canEngagePost,
  togglePostStatus
};
