const express = require("express");
const router = express.Router();
const Store = require("../Models/store");
const mongoose = require("mongoose");

// ========================================
// ✅ ADD STORE (FIXED)
// ========================================
router.post("/store/add", async (req, res) => {
  try {
    let { domain, accessToken } = req.body;

    // ✅ validation
    if (!domain || !accessToken) {
      return res.status(400).json({
        error: "Domain and accessToken are required",
      });
    }

    // ✅ clean domain
    domain = domain
      .replace(/^https?:\/\//, "")
      .replace(/\/$/, "")
      .trim()
      .toLowerCase();

    // ✅ check duplicate
    const existing = await Store.findOne({ domain });
    if (existing) {
      return res.status(400).json({
        error: "Store already exists",
      });
    }

    // ✅ create store
    const newStore = await Store.create({
      domain,
      accessToken,
    });

    res.json({
      success: true,
      store: newStore,
    });

  } catch (err) {
    console.error("ADD STORE ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});


// ========================================
// ✅ GET ALL STORES (FIXED)
// ========================================
router.get("/store", async (req, res) => {

  try {

    const stores =
      await Store.find().lean();

    res.json(stores);

  } catch (err) {

    res.status(500).json({
      error: err.message
    });

  }

});


// ========================================
// ✅ DELETE ALL STORES
// ========================================
router.delete("/stores/delete-all", async (req, res) => {
  try {
    await Store.deleteMany({});

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ========================================
// ✅ DELETE SINGLE STORE
// ========================================
router.delete("/store/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid ID format" });
    }

    const deleted = await Store.findByIdAndDelete(id);

    if (!deleted) {
      return res.status(404).json({ error: "Store not found" });
    }

    res.json({ message: "Store deleted successfully" });

  } catch (err) {
    console.error("DELETE ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});


// ========================================
// ✅ UPDATE STORE
// ========================================
router.put("/store/:id", async (req, res) => {
  try {
    let { domain, accessToken } = req.body;

    if (!domain || !accessToken) {
      return res.status(400).json({
        error: "Domain and accessToken required",
      });
    }

    domain = domain
      .replace(/^https?:\/\//, "")
      .replace(/\/$/, "")
      .trim()
      .toLowerCase();

    const updated = await Store.findByIdAndUpdate(
      req.params.id,
      { domain, accessToken },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ error: "Store not found" });
    }

    res.json(updated);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SAVE STORE
router.post("/store/save", async (req, res) => {

  try {

    let {
      domain,
      accessToken,
      shopName
    } = req.body;

    // =========================
    // VALIDATION
    // =========================

    if (!domain || !accessToken) {

      return res.status(400).json({
        error: "Missing fields"
      });

    }

    // =========================
    // CLEAN DOMAIN
    // =========================

    domain = domain
      .replace(/^https?:\/\//, "")
      .replace(/\/$/, "")
      .trim()
      .toLowerCase();

    // =========================
    // VERIFY TOKEN
    // =========================

    const verifyResponse = await fetch(

      `https://${domain}/admin/api/2024-01/shop.json`,

      {
        headers: {
          "X-Shopify-Access-Token":
            accessToken,
          "Content-Type":
            "application/json"
        }
      }

    );

    // INVALID TOKEN
    if (!verifyResponse.ok) {

      return res.status(401).json({
        error:
          "Invalid or expired token"
      });

    }

    // =========================
    // UPSERT STORE
    // =========================

    const store = await Store.findOneAndUpdate(

      {
        domain
      },

      {
        domain,
        accessToken,
        shopName,
        updatedAt: new Date()
      },

      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true
      }

    );

    res.json({
      success: true,
      message: "Store saved",
      store
    });

  } catch (err) {

    console.error(
      "STORE SAVE ERROR:",
      err.message
    );

    res.status(500).json({
      error: err.message
    });

  }

});

module.exports = router;