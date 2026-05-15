const Analytics = require("../Models/analyticsModel");
const router = require("./search");
const Click = require("../Models/clickModel");

router.post("/analytics", async (req, res) => {
  try {
    const {
      vendor,
      type,
      query,
      productId,
      store,
      productTitle,   // 🔥 ADD
      productImage    // 🔥 ADD
    } = req.body;

    console.log("BODY RECEIVED:", req.body);

    if (!store) {
      return res.status(400).json({ error: "Store is required" });
    }
    await Analytics.create({
      type,
      query,
      normalizedQuery:
        (query || "")
          .toLowerCase()
          .trim(),
      productId,
      productTitle:
        productTitle || null,
      productHandle:
        productHandle || null,
      productImage:
        productImage || null,
      vendor:
        vendor || null,
      store,
      device:
        req.headers["user-agent"]
          ?.includes("Mobile")
          ? "mobile"
          : "desktop",
    });

    res.json({ success: true });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/analytics/stats", async (req, res) => {
  try {
    const now = new Date();

    const last7Days = new Date();
    last7Days.setDate(now.getDate() - 7);

    const prev7Days = new Date();
    prev7Days.setDate(now.getDate() - 14);

    const { store } = req.query;

    const currentSearches = await Analytics.countDocuments({
      type: "search",
      store: store,
      createdAt: { $gte: last7Days },
    });

    const prevSearches = await Analytics.countDocuments({
      type: "search",
      store: store,
      createdAt: { $gte: prev7Days, $lt: last7Days },
    });

    // 🔥 FUNCTION
    const calcGrowth = (current, prev) => {
      if (prev === 0) return 100;
      return (((current - prev) / prev) * 100).toFixed(1);
    };

    res.json({
      totalSearches: currentSearches,
      searchesGrowth: calcGrowth(currentSearches, prevSearches),

      // same logic clicks ke liye bhi lagao
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/analytics/top-searches", async (req, res) => {
  const { store } = req.query;
  const data = await Analytics.aggregate([
    { $match: { type: "search", store: store } },
    { $group: { _id: "$query", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 10 },
  ]);

  res.json(data);
});

router.get("/analytics/top-products", async (req, res) => {
  try {
    const { store } = req.query;

    const match = {
      type: "click",
      productId: { $exists: true }
    };

    if (store) {
      match.store = store;
    }

    const data = await Analytics.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$productId",
          title: { $max: "$productTitle" },
          image: { $max: "$productImage" },
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } },
      { $limit: 5 }
    ]);

    res.json(data);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/analytics/recent-searches", async (req, res) => {
  const { store } = req.query;
  const data = await Analytics.find({ type: "search", store: store })
    .sort({ createdAt: -1 })
    .limit(5);

  res.json(data);
});

router.get("/analytics/search-trends", async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const { store } = req.query;
    const data = await Analytics.aggregate([
      {
        $match: {
          type: "search",
          createdAt: { $gte: startDate },
          store: store
        },
      },
      {
        $group: {
          _id: {
            date: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: "$createdAt",
              },
            },
            store: "$store",
          },
          count: { $sum: 1 },
        },
      },
      {
        $sort: { "_id.date": 1 },
      },
    ]);

    console.log("SEARCH TRENDS:", data); // 🔥 debug

    res.json(data);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get("/analytics/stats/all", async (req, res) => {
  try {
    const totalSearches = await Analytics.countDocuments({
      type: "search",
      store: { $exists: true }
    });

    const totalClicks = await Analytics.countDocuments({
      type: "click",
      store: { $exists: true }
    });

    const stores = await Analytics.aggregate([
      {
        $match: {
          store: { $exists: true }
        }
      },
      {
        $group: {
          _id: "$store",
          totalSearches: {
            $sum: { $cond: [{ $eq: ["$type", "search"] }, 1, 0] }
          },
          totalClicks: {
            $sum: { $cond: [{ $eq: ["$type", "click"] }, 1, 0] }
          }
        }
      }
    ]);

    const storesWithConversion = stores.map(s => ({
      ...s,
      conversionRate:
        s.totalSearches === 0
          ? 0
          : ((s.totalClicks / s.totalSearches) * 100).toFixed(1)
    }));

    res.json({
      totals: {
        totalSearches,
        totalClicks,
        conversionRate:
          totalSearches === 0
            ? 0
            : ((totalClicks / totalSearches) * 100).toFixed(1)
      },
      stores: storesWithConversion
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/analytics/clear", async (req, res) => {
  try {
    await Analytics.deleteMany({});
    res.json({ message: "All analytics deleted ✅" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/analytics/click", async (req, res) => {

  const { productId, query, store } = req.body;

  try {

    let existing = await Click.findOne({
      productId,
      query,
      store
    });

    if (existing) {
      existing.count += 1;
      await existing.save();
    } else {
      await Click.create({
        productId,
        query,
        store,
        count: 1
      });
    }

    res.json({ success: true });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }

});

module.exports = router;