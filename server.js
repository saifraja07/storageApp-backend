import "dotenv/config";
import cors from "cors";
import express from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";

import directoryRoutes from "./routes/directoryRoutes.js";
import fileRoutes from "./routes/fileRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import authRoutes from "./routes/authRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";
import subscriptionRoutes from "./routes/subscriptionRoutes.js";
import webhookRoutes from "./routes/webhookRoutes.js";

import checkAuth from "./middleWares/authMiddleware.js";
import { connectDB } from "./config/db.js";
import { cleanupUploads } from "./utils/cleanupUploads.js";
import { runSubscriptionExpiryJob } from "./jobs/subscriptionCron.js";


const app = express();
app.use(helmet());
app.set("trust proxy", 1);

const allowedOrigins = process.env.CLIENT_URLS.split(",").map(url => url.trim());

app.use(cookieParser(process.env.SESSION_SECRET));
app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  }),
);

app.use("/webhook", webhookRoutes);

// Global JSON parser — runs for all routes below this point
app.use(express.json());

app.get("/", (req, res) => {
  return res.json({
    message: "Hello from mirhaadi storage app, App is working fine in production environment.",
    timeStamp: new Date().toLocaleString()
  });
});

app.use("/", userRoutes);
app.use("/auth", authRoutes);
app.use("/file", checkAuth, fileRoutes);
app.use("/directory", checkAuth, directoryRoutes);
app.use("/subscription", checkAuth, subscriptionRoutes);
app.use("/admin", checkAuth, adminRoutes);

app.use((err, req, res, next) => {
  console.dir(err, { depth: null });
  if (res.headersSent) {
    return next(err);
  }
  return res.status(err.status || 500).json({ error: "Something went wrong! try again later." });
});

if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  await connectDB();

  setInterval(async () => {
    try {
      await cleanupUploads();
    } catch (err) {
      console.error(err);
    }
  }, 60 * 60 * 1000);

  setTimeout(async () => {
    try { await runSubscriptionExpiryJob(); }
    catch (err) { console.error("[cron] initial run error:", err); }

    setInterval(async () => {
      try { await runSubscriptionExpiryJob(); }
      catch (err) { console.error("[cron] error:", err); }
    }, 24 * 60 * 60 * 1000);
  }, 30 * 1000); // 30-second warm-up delay

  const PORT = process.env.PORT;

  app.listen(PORT, () => {
    console.log("Server Started");
  });
}

export default app;