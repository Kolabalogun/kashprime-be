const { supabaseAdmin } = require('../services/supabase.service');
const crypto = require('crypto');

const generateCode = () => {
    return crypto.randomBytes(8).toString('hex').toUpperCase(); // 16 alphanumeric digits
};

// @desc    Generate deposit codes
// @route   POST /api/codes/generate
// @access  Admin
exports.generateCodes = async (req, res) => {
    try {
        const { amount, merchant_id, count } = req.body;
        const codeCount = Number(count || 1);
        const codeAmount = Number(amount);
        const totalValue = codeAmount * codeCount;
        
        if (![3000, 5000, 10000, 20000, 50000].includes(codeAmount)) {
            return res.status(400).json({ success: false, error: 'Invalid denomination' });
        }
        
        if (!merchant_id) {
            return res.status(400).json({ success: false, error: 'Merchant ID is required' });
        }

        if (!Number.isInteger(codeCount) || codeCount < 1 || codeCount > 100) {
            return res.status(400).json({ success: false, error: 'Count must be between 1 and 100' });
        }

        const { data: merchant, error: merchantError } = await supabaseAdmin
            .from('users')
            .select('id, username, role, wallets(vending_balance)')
            .eq('id', merchant_id)
            .single();

        if (merchantError || !merchant || !['merchant', 'vendor', 'super_vendor'].includes(merchant.role)) {
            return res.status(400).json({ success: false, error: 'Valid merchant is required' });
        }

        const wallet = Array.isArray(merchant.wallets) ? merchant.wallets[0] : merchant.wallets;
        const currentVending = parseFloat(wallet?.vending_balance || 0);
        if (currentVending < totalValue) {
            return res.status(400).json({
                success: false,
                error: `Insufficient vending balance. Merchant has ₦${currentVending.toLocaleString()} available.`
            });
        }

        const codesToInsert = [];
        for (let i = 0; i < codeCount; i++) {
            codesToInsert.push({
                code: generateCode(),
                amount: codeAmount,
                merchant_id,
                created_by: req.user.id,
                status: 'active'
            });
        }

        const { error: walletError } = await supabaseAdmin
            .from('wallets')
            .update({
                vending_balance: currentVending - totalValue,
                updated_at: new Date().toISOString()
            })
            .eq('user_id', merchant_id);

        if (walletError) throw walletError;

        const { data, error } = await supabaseAdmin
            .from('deposit_codes')
            .insert(codesToInsert)
            .select('*');

        if (error) {
            await supabaseAdmin
                .from('wallets')
                .update({
                    vending_balance: currentVending,
                    updated_at: new Date().toISOString()
                })
                .eq('user_id', merchant_id);
            throw error;
        }
        
        // Log activity
        await supabaseAdmin.from('admin_activities').insert({
            admin_id: req.user.id,
            activity_type: 'generate_codes',
            description: `Generated ${codeCount} codes worth ${amount} for merchant ${merchant_id}`,
            metadata: { count: codeCount, amount: codeAmount, total_value: totalValue }
        });

        res.status(201).json({ success: true, data, remaining_vending_balance: currentVending - totalValue });
    } catch (error) {
        console.error('Generate codes error:', error);
        res.status(500).json({ success: false, error: error.message || 'Server error' });
    }
};

// @desc    Get all deposit codes
// @route   GET /api/codes
// @access  Admin or Merchant
exports.getCodes = async (req, res) => {
    try {
        let query = supabaseAdmin
            .from('deposit_codes')
            .select(`
                *,
                merchant:users!merchant_id (id, full_name, username),
                user:users!used_by (id, full_name, username)
            `)
            .order('created_at', { ascending: false });

        // If not admin, only show codes assigned to this user
        if (req.user.role !== 'admin' && req.user.role !== 'super_admin') {
            query = query.eq('merchant_id', req.user.id);
        }

        const { data, error } = await query;

        if (error) throw error;

        res.status(200).json({ success: true, data });
    } catch (error) {
        console.error('Get codes error:', error);
        res.status(500).json({ success: false, error: error.message || 'Server error' });
    }
};

// @desc    Delete deposit codes (bulk)
// @route   DELETE /api/codes
// @access  Admin
exports.deleteCodes = async (req, res) => {
    try {
        const { ids } = req.body;

        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ success: false, error: 'An array of code IDs is required' });
        }

        // Only allow deletion of active (un-redeemed) codes
        const { data: toDelete, error: fetchError } = await supabaseAdmin
            .from('deposit_codes')
            .select('id, status, code, amount, merchant_id')
            .in('id', ids);

        if (fetchError) throw fetchError;

        const redeemedCodes = toDelete.filter(c => c.status === 'used');
        if (redeemedCodes.length > 0) {
            return res.status(400).json({
                success: false,
                error: `Cannot delete ${redeemedCodes.length} already-redeemed code(s). Only active codes can be deleted.`
            });
        }

        const { error: deleteError } = await supabaseAdmin
            .from('deposit_codes')
            .delete()
            .in('id', ids);

        if (deleteError) throw deleteError;

        const refundByMerchant = {};
        toDelete.forEach((code) => {
            refundByMerchant[code.merchant_id] = (refundByMerchant[code.merchant_id] || 0) + parseFloat(code.amount || 0);
        });

        for (const [merchantId, refundAmount] of Object.entries(refundByMerchant)) {
            const { data: wallet } = await supabaseAdmin
                .from('wallets')
                .select('vending_balance')
                .eq('user_id', merchantId)
                .single();

            await supabaseAdmin
                .from('wallets')
                .update({
                    vending_balance: parseFloat(wallet?.vending_balance || 0) + refundAmount,
                    updated_at: new Date().toISOString()
                })
                .eq('user_id', merchantId);
        }

        // Log activity
        await supabaseAdmin.from('admin_activities').insert({
            admin_id: req.user.id,
            activity_type: 'delete_codes',
            description: `Deleted ${ids.length} deposit code(s)`,
            metadata: { deleted_count: ids.length, ids }
        });

        res.status(200).json({ success: true, message: `${ids.length} code(s) deleted successfully` });
    } catch (error) {
        console.error('Delete codes error:', error);
        res.status(500).json({ success: false, error: error.message || 'Server error' });
    }
};
