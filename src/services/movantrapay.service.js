const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config({ override: true });

const getBaseUrl = () => process.env.MOVANTRA_BASE_URL || 'https://api.movantrapay.com/v1';
const getApiKey = () => (process.env.MOVANTRA_SECRET_KEY || process.env.MOVANTRA_API_KEY || 'mvt_sk_live_ca677930b09516506366b577896f12ba').trim();
const getSlug = () => process.env.MOVANTRA_CHECKOUT_SLUG || 'kashprime';
const getWebhookSecret = () => process.env.MOVANTRA_WEBHOOK_SECRET || getApiKey();

class MovantrapayService {
  /**
   * Initiate a dynamic bank transfer checkout for a payment
   * Primary: Generate live PalmPay virtual account via core API
   * Secondary: Initiate via checkout slug API
   */
  static async initiateCheckout({ customerName, customerEmail, customerPhone, amountNaira, slug }) {
    const customerRef = `MVT_CHK_${Date.now().toString(36).toUpperCase()}_${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const amountKobo = Math.round(parseFloat(amountNaira) * 100);

    // Primary: Generate PalmPay Virtual Account
    try {
      const vaRes = await this.createPalmPayVirtualAccount({
        customerRef,
        name: customerName || 'Kashprime Customer',
        email: customerEmail || 'customer@kashprime.com',
        phone: customerPhone || '08000000000'
      });

      if (vaRes && vaRes.success && vaRes.data) {
        const data = vaRes.data;
        return {
          success: true,
          reference: data.customer_ref || customerRef,
          account_number: data.account_number,
          bank_name: data.bank_name || 'PalmPay',
          account_name: data.account_name || `MOVANTRA / ${customerName || 'Kashprime Customer'}`,
          amount_kobo: amountKobo,
          total_kobo: amountKobo,
          amount_naira: parseFloat(amountNaira),
          expires_at: expiresAt,
          raw: data
        };
      }
    } catch (vaError) {
      console.warn('[MovantrapayService] Virtual account direct creation warning:', vaError.response?.data || vaError.message);
    }

    // Secondary: Try hosted checkout slug initiate endpoint
    try {
      const targetSlug = slug || getSlug();
      const url = `${getBaseUrl()}/checkout/${targetSlug}/initiate`;

      const payload = {
        customer_name: customerName || 'Kashprime Customer',
        customer_email: customerEmail || 'customer@kashprime.com',
        customer_phone: customerPhone || '+2348000000000',
        amount_kobo: amountKobo
      };

      const response = await axios.post(url, payload, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${getApiKey()}`
        },
        timeout: 10000
      });

      if (response.data && response.data.payment) {
        const payment = response.data.payment;
        return {
          success: true,
          reference: payment.reference,
          account_number: payment.account_number,
          bank_name: payment.bank_name || 'PalmPay',
          account_name: payment.account_name,
          amount_kobo: payment.amount_kobo,
          total_kobo: payment.total_kobo || payment.amount_kobo,
          amount_naira: (payment.total_kobo || payment.amount_kobo) / 100,
          expires_at: payment.expires_at || expiresAt,
          raw: payment
        };
      }
    } catch (checkoutError) {
      console.error('[MovantrapayService] Checkout API error:', checkoutError.response?.data || checkoutError.message);
    }

    throw new Error('Failed to generate dynamic account number from Movantrapay. Please check API configuration.');
  }

  /**
   * Check status of a checkout payment or transaction reference
   */
  static async checkStatus(reference) {
    // 1. Try checkout status endpoint
    try {
      const url = `${getBaseUrl()}/checkout/status/${reference}`;
      const response = await axios.get(url, {
        headers: {
          'Authorization': `Bearer ${getApiKey()}`
        },
        timeout: 8000
      });

      if (response.data) {
        return {
          success: true,
          state: response.data.state || (response.data.paid ? 'paid' : 'pending'),
          paid: !!response.data.paid,
          raw: response.data
        };
      }
    } catch (error) {
      // 2. Fallback: check transaction log for matching reference
      try {
        const txUrl = `${getBaseUrl()}/transactions`;
        const txRes = await axios.get(txUrl, {
          headers: { 'Authorization': `Bearer ${getApiKey()}` },
          timeout: 8000
        });

        if (txRes.data && Array.isArray(txRes.data.data)) {
          const match = txRes.data.data.find(t =>
            t.reference === reference ||
            (t.customer_ref && t.customer_ref === reference)
          );
          if (match) {
            const isPaid = match.status === 'successful' || match.status === 'completed' || match.status === 'paid';
            return {
              success: true,
              state: isPaid ? 'paid' : match.status,
              paid: isPaid,
              raw: match
            };
          }
        }
      } catch (txErr) {
        console.error('[MovantrapayService] Transaction log check error:', txErr.message);
      }

      console.error('[MovantrapayService] Check status error:', error.response?.data || error.message);
    }

    return {
      success: false,
      state: 'pending',
      paid: false
    };
  }

  /**
   * Create a PalmPay virtual account for a customer
   * Endpoint: POST /palmpay/virtual-accounts
   */
  static async createPalmPayVirtualAccount({ customerRef, name, email, phone }) {
    try {
      const url = `${getBaseUrl()}/palmpay/virtual-accounts`;
      const payload = {
        customer_ref: customerRef,
        name: name,
        email: email,
        phone: phone
      };

      const response = await axios.post(url, payload, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${getApiKey()}`
        },
        timeout: 10000
      });

      if (response.data && response.data.status) {
        return {
          success: true,
          data: response.data.data
        };
      }

      throw new Error(response.data?.message || 'Failed to create PalmPay virtual account');
    } catch (error) {
      console.error('[MovantrapayService] Create PalmPay account error:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Fetch bank list for KYC / payouts
   * Endpoint: GET /kyc/banks
   */
  static async getBanks() {
    try {
      const url = `${getBaseUrl()}/kyc/banks`;
      const response = await axios.get(url, { timeout: 10000 });
      if (response.data && response.data.ok) {
        return { success: true, banks: response.data.banks };
      }
      return { success: false, banks: [] };
    } catch (error) {
      console.error('[MovantrapayService] Get banks error:', error.message);
      return { success: false, banks: [] };
    }
  }

  /**
   * Resolve account details for KYC
   * Endpoint: POST /kyc/resolve-account
   */
  static async resolveAccount(accountNumber, bankCode) {
    try {
      const url = `${getBaseUrl()}/kyc/resolve-account`;
      const response = await axios.post(url, {
        account_number: accountNumber,
        bank_code: bankCode
      }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000
      });

      if (response.data && response.data.ok) {
        return {
          success: true,
          account_name: response.data.account_name,
          account_number: response.data.account_number,
          bank_code: response.data.bank_code
        };
      }

      return { success: false, message: response.data?.message || 'Account resolution failed' };
    } catch (error) {
      console.error('[MovantrapayService] Resolve account error:', error.response?.data || error.message);
      return { success: false, message: error.response?.data?.message || 'Account resolution failed' };
    }
  }

  /**
   * Verify Webhook Signature (HMAC SHA-512)
   */
  static verifyWebhookSignature(rawBody, signatureHeader) {
    if (!signatureHeader) return false;
    const secret = getWebhookSecret();
    const computedSignature = crypto
      .createHmac('sha512', secret)
      .update(typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody))
      .digest('hex');

    try {
      return crypto.timingSafeEqual(
        Buffer.from(signatureHeader),
        Buffer.from(computedSignature)
      );
    } catch (e) {
      return signatureHeader === computedSignature;
    }
  }
}

module.exports = MovantrapayService;
