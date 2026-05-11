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
    domain = domain.replace("https://", "").trim();

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

    console.log("✅ STORE SAVED:", newStore);

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
    const stores = await Store.find(); // 🔥 token bhi dikhega
    console.log("📦 STORES:", stores);

    res.json(stores);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ========================================
// ✅ DELETE ALL STORES
// ========================================
router.delete("/stores/delete-all", async (req, res) => {
  try {
    await Store.deleteMany({});
    console.log("🗑️ ALL STORES DELETED");

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

    console.log("🗑️ STORE DELETED:", id);

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

    domain = domain.replace("https://", "").trim();

    const updated = await Store.findByIdAndUpdate(
      req.params.id,
      { domain, accessToken },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ error: "Store not found" });
    }

    console.log("✏️ STORE UPDATED:", updated);

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

    console.log("SAVING DOMAIN:", domain);

    // =========================
    // FIND STORE
    // =========================
    const existingStore =
      await Store.findOne({
        domain
      });

    // =========================
    // UPDATE
    // =========================
    if (existingStore) {

      existingStore.accessToken =
        accessToken;

      existingStore.shopName =
        shopName;

      await existingStore.save();

      console.log("STORE UPDATED");

      return res.json({
        success: true,
        message: "Store updated"
      });
    }

    // =========================
    // CREATE
    // =========================
    await Store.create({
      domain,
      accessToken,
      shopName
    });

    console.log("STORE CREATED");

    res.json({
      success: true,
      message: "Store saved"
    });

  } catch (err) {

    console.log(
      "STORE SAVE ERROR:",
      err
    );

    res.status(500).json({
      error: err.message
    });
  }
});

module.exports = router;