const sendEmail = async (to, subject, html) => {
  console.log(`[Email Service Bypass] Mock send email to ${to}: Subject: ${subject}`);
  return { status: "success", bypassed: true };
};

// Send password reset OTP
const sendPasswordResetOTP = async (userData, otp) => {
  console.log(`[Email Service Bypass] Password reset OTP for ${userData.email} is: ${otp}`);
  return { status: "success", bypassed: true };
};

// Send welcome email
const sendWelcomeEmail = async (userData) => {
  console.log(`[Email Service Bypass] Welcome email for ${userData.email}`);
  return { status: "success", bypassed: true };
};

// Send password change confirmation
const sendPasswordChangeConfirmation = async (userData) => {
  console.log(`[Email Service Bypass] Password change confirmation for ${userData.email}`);
  return { status: "success", bypassed: true };
};

module.exports = {
  sendEmail,
  sendPasswordResetOTP,
  sendWelcomeEmail,
  sendPasswordChangeConfirmation
};