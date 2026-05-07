const express = require("express");
const cors = require("cors");
const mongoose = require('mongoose')
require("dotenv").config();
const webhooks = require('./Routes/webhookRoutes');

const app = express();

app.use("/webhooks", express.raw({ type: "application/json" }));
app.use(express.json());
const allowedOrigins = [
  "https://admin.shopify.com",
  "https://tbp-search-app.tbp-search.workers.dev" // ✅ worker add
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);

    if (
      allowedOrigins.includes(origin) ||
      origin.endsWith(".myshopify.com") ||
      origin.includes(".trycloudflare.com")
    ) {
      return callback(null, true);
    }

    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true
}));

// MongoDB Connection
mongoose.connect(
    process.env.MONGO_DB_URI
)
// database connect
const db = mongoose.connection;
db.on('error', (error) => {
    console.log("Error Occured", error);
});
db.once('connected', () => {
    console.log('MongoDB connected');
})

// Routes files import
const productsRoute = require("./Routes/productsRoute");
const searchRoute = require("./Routes/search");
const storesRoute = require('./Routes/storeRoute')
const analyticsRoute = require('./Routes/analyticsRoute')
const settingsRoute = require('./Routes/settingsRoute')
const authRoutes = require("./Routes/authRoutes");

// routes
app.use("/api", searchRoute);
app.use("/api", storesRoute);
app.use('/api', analyticsRoute)
app.use('/api', settingsRoute)
app.use("/api/", productsRoute);
app.use("/webhooks", webhooks);
app.use("/auth", authRoutes);

app.get("/", (req, res) => {
    res.send("Backend Running Successfully✅");
});

app.listen(process.env.PORT || 3000, () => {
    console.log(`Server running on port ${process.env.PORT}`);
});