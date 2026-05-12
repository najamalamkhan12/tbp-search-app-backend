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
];

app.use(cors({
  origin: function (origin, callback) {

    // POSTMAN / SERVER REQUESTS
    if (!origin) {
      return callback(null, true);
    }

    console.log("ORIGIN:", origin);

    // SHOPIFY STORES
    if (
      origin.endsWith(".myshopify.com") ||
      origin.includes(".trycloudflare.com") ||
      origin.includes(".workers.dev") ||
      origin.includes("nainpreet.com")
    ) {
      return callback(null, true);
    }

    return callback(null, true); // 🔥 TEMP ALLOW ALL
  },

  credentials: true,
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
const synonymRoutes = require("./Routes/synonymRoute");
const boostRoute = require("./Routes/boostRoute");


// routes
app.use("/api", searchRoute);
app.use("/api", storesRoute);
app.use('/api', analyticsRoute)
app.use('/api', settingsRoute)
app.use("/api/", productsRoute);
app.use("/webhooks", webhooks);
app.use("/auth", authRoutes);
app.use("/api/synonyms", synonymRoutes);
app.use("/api/boost", boostRoute);

app.get("/", (req, res) => {
    res.send("Backend Running Successfully✅");
});

app.listen(process.env.PORT || 3000, () => {
    console.log(`Server running on port ${process.env.PORT}`);
});