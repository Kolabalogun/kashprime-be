const { default: axios } = require('axios');
const transporter = require('../../config/smtp');
const emailTemplates = require('./templates');
require('dotenv').config();

 

const sendEmail = async (to, subject, html) => {
  try {
    const payload = {
      from: {
        email: "noreply@email.lumikash.tech",  
        name: "Lumikash",
      },
      recipients: [
        {
          email: to,
          name: to.split("@")[0],  
        },
      ],
      subject,
      text_content: "Your email client does not support HTML.",
      html_content: html,
    };

    const response = await axios.post(
      `https://api.ahasend.com/v2/accounts/${process.env.EMAIL_ACCOUNT_ID}/messages`,
      payload,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.EMAIL_API_KEY}`  
        },
      }
    );

    return response.data;
  } catch (error) {
    console.error("❌ Error sending email:", error.response?.data || error.message);
  }
};

// Send password reset OTP
const sendPasswordResetOTP = async (userData, otp) => {
  const subject = 'Password Reset Code - LUMIKASH';
  const html = emailTemplates.passwordResetOTP(userData, otp);
  
  return await sendEmail(userData.email, subject, html);
};

// Send welcome email
const sendWelcomeEmail = async (userData) => {
  const subject = 'Welcome to LUMIKASH - Your Account is Ready!';
  const html = emailTemplates.welcomeEmail(userData, { user_tier: userData.user_tier });
  
  return await sendEmail(userData.email, subject, html);
};

// Send password change confirmation
const sendPasswordChangeConfirmation = async (userData) => {
  const subject = 'Password Changed Successfully - LUMIKASH';
  const html = emailTemplates.passwordChangeConfirmation(userData);
  
  return await sendEmail(userData.email, subject, html);
};

module.exports = {
  sendEmail,
  sendPasswordResetOTP,
  sendWelcomeEmail,
  sendPasswordChangeConfirmation
};