const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");

const authRoutes = require("./routes/auth.routes");
const userRoutes = require("./routes/user.routes");
const investmentsRoutes = require("./routes/investment.routes");
// const socialRoutes = require("./routes/social.routes");
// const kashfeedRoutes = require("./routes/kashfeed.routes");
// const jobsRoutes = require("./routes/jobs.routes");
const adminRoutes = require("./routes/admin.routes");
const withdrawalRoutes = require("./routes/withdrawal.routes");
// const liveButtonRoutes = require("./routes/liveButton.routes");
// const transferRoutes = require("./routes/transfer.routes");
const kashskitRoutes = require("./routes/kashskit.routes");
// const luckyJetRoutes = require("./routes/luckyJet.routes");
// const raffleRoutes = require("./routes/raffle.routes");
const minesRoutes = require("./routes/mines.routes");
const coinflipRoutes = require("./routes/coinflip.routes");
const gamesRoutes = require("./routes/gaming.routes");
const paymentRoutes = require("./routes/payments.routes");
const sponsoredPostRoutes = require("./routes/sponsored.posts.routes");
const kashAdsRoutes = require("./routes/kashAdsRoutes");
const hub88Routes = require("./routes/hub88.routes");
const spinWheelRoutes = require('./routes/spinWheel.routes');
const diceRollRoutes = require('./routes/diceRoll.routes');
const plinkoRoutes = require('./routes/plinko.routes');
const colorPickRoutes = require('./routes/colorPick.routes');
const higherLowerRoutes = require('./routes/higherLower.routes');
const towerClimbRoutes = require('./routes/towerClimb.routes');
const scratchCardRoutes = require('./routes/scratchCard.routes');
const kenoRoutes = require('./routes/keno.routes');

const app = express();

const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:5173",

  "https://kashprime.com",
  "https://www.kashprime.com",
  "https://kashprime-production.up.railway.app",

];

// Robust CORS implementation
app.use((req, res, next) => {
  const origin = req.headers.origin;
  // Clean origin by removing trailing slash for comparison
  const cleanOrigin = origin ? origin.replace(/\/$/, "") : null;

  if (cleanOrigin && allowedOrigins.includes(cleanOrigin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, PATCH, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With, Accept, Origin"
  );

  // Handle preflight (OPTIONS)
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  next();
});

// Also keep the cors package as a backup/standard for some library expectations
app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
      "Accept",
      "Origin",
    ],
    optionsSuccessStatus: 200,
  })
);


// Security middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: false, // Disable CSP for local dev if needed, or configure it properly
}));

// // Rate limiting
// const limiter = rateLimit({
//   windowMs: 15 * 60 * 1000, // 15 minutes
//   max: 200,
//   message: "Too many requests from this IP, please try again later.",
// });
// app.use("/api/", limiter);

// Body parsing middleware
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: "500mb" }));
app.use(express.urlencoded({ extended: true, limit: "500mb" }));

// Logging middleware
if (process.env.NODE_ENV === "development") {
  app.use(morgan("dev"));
}
// Static files
app.use("/uploads", express.static("uploads"));

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "success",
    message: "LUMIKASH API is running",
    timestamp: new Date().toISOString(),
  });
});

// API routes
app.use("/api/auth", authRoutes);
app.use("/api/user", userRoutes);
app.use("/api/investments", investmentsRoutes);
// app.use("/api/social", socialRoutes);
// app.use("/api/kashfeed", kashfeedRoutes);
// app.use("/api/jobs", jobsRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/hub88", hub88Routes);
app.use('/api/spin-wheel', spinWheelRoutes);
app.use('/api/dice-roll', diceRollRoutes);
app.use('/api/plinko', plinkoRoutes);
app.use('/api/color-pick', colorPickRoutes);
app.use('/api/higher-lower', higherLowerRoutes);
app.use('/api/tower-climb', towerClimbRoutes);
app.use('/api/scratch-card', scratchCardRoutes);
app.use('/api/keno', kenoRoutes);
app.use("/api/withdrawal", withdrawalRoutes);
// app.use("/api/live-button", liveButtonRoutes);
// app.use("/api/transfer", transferRoutes);
app.use("/api/kashskit", kashskitRoutes);
// app.use("/api/raffle", raffleRoutes);
// app.use("/api/lucky-jet", luckyJetRoutes);
app.use("/api/mines", minesRoutes);
app.use("/api/coinflip", coinflipRoutes);
app.use("/api/games", gamesRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/sponsored-posts', sponsoredPostRoutes);
app.use('/api/kash-ads', kashAdsRoutes);
app.use('/api/user-ads', require('./routes/userAds.routes'));
app.use('/api/codes', require('./routes/codes.routes'));

// 404 handler - Express v5 compatible
app.use((req, res, next) => {
  res.status(404).json({
    status: "error",
    message: `Route ${req.originalUrl} not found`,
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error(err.stack);

  res.status(err.status || 500).json({
    status: "error",
    message: err.message || "Internal server error",
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
});

module.exports = app;
