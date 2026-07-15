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

// Trust proxy settings for express-rate-limit behind reverse proxies (like Railway, Heroku, Cloudflare)
app.set("trust proxy", 1);


// Default whitelist, extendable via CORS_ALLOWED_ORIGINS without a code change/redeploy
// e.g. CORS_ALLOWED_ORIGINS="https://staging.kashprime.com,https://foo.kashprime.com"
const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:5173",
  "https://kashprime.com",
  "https://www.kashprime.com",
  "https://kashprime-production.up.railway.app",
];

const envOrigins = (process.env.CORS_ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const allowedOrigins = [...new Set([...DEFAULT_ALLOWED_ORIGINS, ...envOrigins])];

app.use(cors({
  origin: (origin, callback) => {
    // No origin header = same-origin/server-to-server/curl request, allow it
    if (!origin) return callback(null, true);

    const cleanOrigin = origin.replace(/\/$/, "");
    if (allowedOrigins.includes(cleanOrigin)) {
      return callback(null, true);
    }

    console.warn(`CORS blocked request from origin: ${origin}`);
    const err = new Error("Access forbidden. Please contact support if you believe this is an error.");
    err.status = 403;
    return callback(err);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept", "Origin"],
}));


// Security middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: false, // Disable CSP for local dev if needed, or configure it properly
}));

// Rate limiting - caps request bursts per IP so a spam-click, broken autoplay
// loop, or scripted flood can't pile up enough concurrent work to stall the
// whole event loop for every user (see 2026-07-14/07-15 CPU-exhaustion incidents).
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "OPTIONS",
  message: {
    status: "error",
    message: "Too many requests. Please slow down and try again shortly.",
  },
});
app.use("/api/", limiter);

// Body parsing middleware
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
// File uploads go through multer (see upload.middleware.js), which has its own
// 5MB limit - JSON/urlencoded bodies here never need to be anywhere near that,
// so keep this small to avoid a single request buffering huge payloads in memory.
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

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
