const express = require("express");
const router = express.Router();
const fetch = require("node-fetch");
const Store = require('../Models/store')
const Analytics = require("../Models/analyticsModel");
const Synonym = require("../Models/synonymModel");
const Boost = require("../Models/boostModel");
const Product = require("../Models/productModel")
const Collection = require("../Models/collectionModel");
const FeaturedBrand = require("../Models/featuredBrandsModel");
const stringSimilarity = require("string-similarity");

const normalizeDomain = (domain) =>
  (domain || "")
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "")
    .trim()
    .toLowerCase();

const escapeRegex = (value) =>
  String(value).replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
const normalizeId = (id) =>
  String(id || "").replace("gid://shopify/Collection/", "").trim();

const toTime = (value) => {
  const time = value ? new Date(value).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
};

const latestProductTime = (product = {}) =>
  // Republish should not make an old product fresh again.
  toTime(product.firstPublishedAt) ||
  toTime(product.shopifyCreatedAt);

const latestCollectionTime = (collection = {}) =>
  // Republish/update should not make an old collection fresh again.
  toTime(collection.firstPublishedAt) ||
  toTime(collection.shopifyCreatedAt);

const daysSinceTime = (time) =>
  time
    ? (Date.now() - time) / (1000 * 60 * 60 * 24)
    : 9999;

const recencyScore = (time, weights = {}) => {
  const daysOld = daysSinceTime(time);

  if (daysOld <= 1) return weights.day1 ?? 45000;
  if (daysOld <= 3) return weights.day3 ?? 35000;
  if (daysOld <= 7) return weights.day7 ?? 25000;
  if (daysOld <= 30) return weights.day30 ?? 12000;
  if (daysOld <= 90) return weights.day90 ?? 4000;
  if (daysOld <= 180) return weights.day180 ?? 1000;

  return 0;
};

// POST /api/stores/add

router.post("/stores/add", async (req, res) => {
  const { storeName, domain, accessToken } = req.body;

  try {
    const newStore = await Store.create({
      storeName,
      domain,
      accessToken
    });

    res.json({ success: true, store: newStore });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =========================
// 🔥 VENDOR CACHE
// =========================

const vendorCache = {};

const CACHE_TIME =
  1000 * 60 * 2 // 10 min

router.get("/search", async (req, res) => {

  try {

    let { q, shop } = req.query;

    // =========================
    // 🔥 CLEAN INPUTS
    // =========================
    shop = (shop || "")
      .replace(/^https?:\/\//, "")
      .replace(/\/$/, "")
      .trim()
      .toLowerCase();
    const cleanStore = shop;
    q = (q || "").trim();

    const originalQuery =
      q.toLowerCase();

    if (!shop) {

      return res.json({
        query: q,
        meta: {},
        vendors: [],
        collections: [],
        products: [],
        suggestions: []
      });

    }

    if (!q) {

      const latestProducts =
        await Product.find({
          store: cleanStore,
          status: "ACTIVE"
        })
          .sort({
            firstPublishedAt: -1,
            shopifyCreatedAt: -1
          })
          .limit(20)
          .lean();

      return res.json({
        query: "",
        meta: {
          emptySearch: true
        },
        vendors: [],
        collections: [],
        products: latestProducts,
        suggestions: []
      });

    }

    // =========================
    // 🔥 APPLY SYNONYM
    // =========================
    const synonymData =
      await Synonym.findOne({
        query: originalQuery,
        store: shop
      });

    let finalQuery =
      originalQuery;

    if (
      synonymData &&
      synonymData.synonyms?.length > 0
    ) {
      finalQuery =
        synonymData.synonyms[0]
          .toLowerCase()
          .trim();
    }

    // =========================
    // 🔥 GET BOOSTS
    // =========================
    const boosts =
      await Boost.find({
        query: originalQuery,
        store: shop
      });

    const boostedIds =
      boosts.map(b =>
        String(b.productId)
      );

    // =========================
    // 🔥 GET ALL VENDORS
    // =========================

    let uniqueVendors = [];

    // CACHE EXISTS
    if (

      vendorCache[shop] &&

      Date.now() -
      vendorCache[shop].timestamp
      < CACHE_TIME

    ) {

      uniqueVendors =
        vendorCache[shop].data;

    } else {

      const vendorDocs =
        await Product.distinct(
          "vendor",
          {
            store: shop,
            status: "ACTIVE"
          }
        );

      uniqueVendors =
        vendorDocs

          .filter(Boolean)

          .map(v => v.trim());

      // SAVE CACHE
      vendorCache[shop] = {
        data: uniqueVendors,
        timestamp: Date.now(),
      };
    }

    // =========================
    // 🔥 NORMALIZE QUERY
    // =========================
    const normalizedQuery =
      finalQuery
        .toLowerCase()
        .trim();

    // =========================
    // 🔥 DETECT BEST VENDOR
    // =========================

    let detectedVendor = null;

    const vendorMatches = uniqueVendors
      .map(v => {

        const vendorName =
          v.toLowerCase();

        let score = 0;

        // EXACT MATCH
        if (
          vendorName === normalizedQuery
        ) {
          score += 100000;
        }

        // STARTS WITH
        if (
          vendorName.startsWith(
            normalizedQuery
          )
        ) {
          score += 50000;
        }

        // CONTAINS
        if (
          vendorName.includes(
            normalizedQuery
          )
        ) {
          score += 20000;
        }

        // TYPO TOLERANCE
        const queryTokens =
          normalizedQuery.split(" ");

        const vendorTokens =
          vendorName.split(" ");

        queryTokens.forEach(qt => {

          vendorTokens.forEach(vt => {

            const sim =
              stringSimilarity.compareTwoStrings(
                qt,
                vt
              );

            if (sim > 0.60) {
              score += sim * 20000;
            }

          });

        });

        // TOKEN MATCHES
        normalizedQuery
          .split(" ")
          .forEach(token => {

            if (
              token.length >= 2 &&
              vendorName.includes(token)
            ) {
              score += 5000;
            }

          });

        return {
          vendor: v,
          score
        };

      })

      .filter(v => v.score > 0)

      .sort((a, b) =>
        b.score - a.score
      );

    if (
      vendorMatches.length &&
      vendorMatches[0].score > 10000
    ) {
      detectedVendor =
        vendorMatches[0].vendor;
    }

    // =========================
    // 🔥 REMAINING QUERY
    // =========================

    let remainingQuery = normalizedQuery;

    if (detectedVendor) {

      const vendorTokens =
        detectedVendor
          .toLowerCase()
          .split(" ");

      const queryTokens =
        normalizedQuery
          .split(" ");

      remainingQuery =
        queryTokens
          .filter(qt => {

            return !vendorTokens.some(vt =>

              stringSimilarity.compareTwoStrings(
                qt,
                vt
              ) > 0.75

            );

          })
          .join(" ")
          .trim();

    }

    // =========================
    // 🔥 TOKENS
    // =========================

    const remainingTokens =

      remainingQuery

        .split(" ")

        .filter(Boolean)

        .map(t =>
          t.toLowerCase()
        );

    // =========================
    // 🔥 SMART SEARCH CONDITIONS
    // =========================
    let searchConditions = [];

    if (detectedVendor) {

      // ✅ VENDOR MATCH
      searchConditions.push({
        vendor: { $regex: escapeRegex(detectedVendor), $options: "i" }
      });

      // ✅ REMAINING QUERY
      if (remainingQuery) {
        searchConditions.push({
          $or: [
            ...remainingTokens.map(t => ({
              title: { $regex: escapeRegex(t), $options: "i" }
            })),
            { searchableText: { $regex: escapeRegex(remainingQuery), $options: "i" } },
            { tags: { $regex: escapeRegex(remainingQuery), $options: "i" } },
            { collections: { $regex: escapeRegex(remainingQuery), $options: "i" } }
          ]
        });
      }

    } else {

      // 🔥 NORMAL SEARCH
      searchConditions.push({
        $or: [
          { title: { $regex: escapeRegex(normalizedQuery), $options: "i" } },
          { vendor: { $regex: escapeRegex(normalizedQuery), $options: "i" } },
          { productType: { $regex: escapeRegex(normalizedQuery), $options: "i" } },
          { searchableText: { $regex: escapeRegex(normalizedQuery), $options: "i" } },
          { tags: { $regex: escapeRegex(normalizedQuery), $options: "i" } },
          { collections: { $regex: escapeRegex(normalizedQuery), $options: "i" } }
        ]
      });
    }

    // =========================
    // 🔥 SEARCH PRODUCTS
    // =========================

    let products =
      await Product.find({
        store: cleanStore,
        status: "ACTIVE",
        $and: searchConditions
      })
        .sort({
          firstPublishedAt: -1,
          shopifyCreatedAt: -1
        })
        .limit(300)
        .lean()

        .select(`
      title
      handle
      vendor
      image
      price
      createdAt
      shopifyCreatedAt
      shopifyPublishedAt
      firstPublishedAt
      shopifyUpdatedAt
      collections
      searchableText
      tags
      status
    `);

    // =========================
    // FALLBACK TYPO SEARCH
    // =========================

    if (
      products.length < 50 &&
      detectedVendor
    ) {
      const fallbackProducts =
        await Product.find({
          store: cleanStore,
          status: "ACTIVE",
          vendor: {
            $regex: escapeRegex(detectedVendor),
            $options: "i"
          }
        }).sort({
          firstPublishedAt: -1,
          shopifyCreatedAt: -1
        })
          .limit(300)
          .lean();
      const existingIds =
        new Set(
          products.map(p =>
            String(p._id)
          )
        );
      fallbackProducts.forEach(p => {
        if (
          !existingIds.has(
            String(p._id)
          )
        ) {
          products.push(p);
        }
      });
    }

    // =========================
    // 🔥 FUZZY KEYWORD FALLBACK
    // typo tolerance for keywords (e.g. "emrodry" → embroidery)
    // sirf keyword search pe (jab koi brand detect na hua ho)
    // =========================
    const FUZZY_THRESHOLD = 0.5; // kam karo (e.g. 0.42) to zyada tolerant — par false matches barhenge

    if (
      !detectedVendor &&
      products.length < 20 &&
      normalizedQuery.length >= 3
    ) {

      const qTokens =
        normalizedQuery.split(" ").filter(t => t.length >= 3);

      if (qTokens.length) {

        const pool = await Product.find({
          store: cleanStore,
          status: "ACTIVE"
        })
          .sort({
            firstPublishedAt: -1,
            shopifyCreatedAt: -1
          })
          .limit(2000)
          .lean()
          .select(`
            title vendor handle image price
            searchableText tags collections
            createdAt shopifyCreatedAt shopifyPublishedAt firstPublishedAt status
          `);

        const existingIds = new Set(products.map(p => String(p._id)));

        pool.forEach(p => {
          if (existingIds.has(String(p._id))) return;

          const haystack = (p.searchableText || p.title || "").toLowerCase();
          const hTokens = haystack.split(/[\s\-|_/,.]+/).filter(Boolean);

          let isMatch = false;
          for (const qt of qTokens) {
            for (const ht of hTokens) {
              if (
                ht.includes(qt) ||
                (
                  Math.abs(qt.length - ht.length) <= 3 &&
                  stringSimilarity.compareTwoStrings(qt, ht) >= FUZZY_THRESHOLD
                )
              ) {
                isMatch = true;
                break;
              }
            }
            if (isMatch) break;
          }

          if (isMatch) products.push(p);
        });
      }
    }

    // =========================
    // 🔥 FORMAT + SCORE PRODUCTS
    // =========================
    products = products.map(p => {

      let score = 0;

      const title =
        (p.title || "")
          .toLowerCase();

      // ======================
      // TITLE TYPO TOLERANCE
      // ======================

      const queryTokens =
        normalizedQuery.split(" ");

      const titleTokens =
        title.split(/[\s\-|_/]+/);

      queryTokens.forEach(qt => {

        titleTokens.forEach(tt => {

          const sim =
            stringSimilarity.compareTwoStrings(
              qt,
              tt
            );

          if (sim > 0.65) {
            score += sim * 15000;
          }

        });

      });

      // FULL TITLE SIMILARITY

      const fullTitleSimilarity =
        stringSimilarity.compareTwoStrings(
          normalizedQuery,
          title
        );

      if (fullTitleSimilarity > 0.4) {
        score += fullTitleSimilarity * 50000;
      }

      const vendor =
        (p.vendor || "")
          .toLowerCase();

      const searchable =
        (
          p.searchableText || ""
        ).toLowerCase();

      const collections =

        Array.isArray(
          p.collections
        )

          ? p.collections
            .join(" ")
            .toLowerCase()

          : (
            p.collections || ""
          )
            .toString()
            .toLowerCase();

      const tags =

        Array.isArray(
          p.tags
        )

          ? p.tags
            .join(" ")
            .toLowerCase()

          : (
            p.tags || ""
          )
            .toString()
            .toLowerCase();

      // ======================
      // EXACT QUERY
      // ======================

      if (
        title === normalizedQuery
      ) {
        score += 100000;
      }

      // ======================
      // TITLE CONTAINS QUERY
      // ======================

      if (
        title.includes(
          normalizedQuery
        )
      ) {

        score += 15000;

      }

      // ======================
      // VENDOR MATCH
      // ======================

      if (

        detectedVendor &&

        vendor.includes(
          detectedVendor
            .toLowerCase()
        )

      ) {

        score += 25000;

      }

      // ======================
      // TITLE HAS VENDOR
      // ======================

      if (

        detectedVendor &&

        title.includes(
          detectedVendor
            .toLowerCase()
        )

      ) {

        score += 12000;

      }

      // ======================
      // TOKEN MATCHING
      // ======================

      remainingTokens.forEach(
        token => {

          if (
            title.includes(token)
          ) {
            score += 12000;
          }

          if (
            searchable.includes(
              token
            )
          ) {
            score += 7000;
          }

          if (
            collections.includes(
              token
            )
          ) {
            score += 5000;
          }

          if (
            tags.includes(token)
          ) {
            score += 4000;
          }

        }
      );

      // ======================
      // RECENCY BOOST 🔥
      // ======================

      const productTime =
        latestProductTime(p);

      score += recencyScore(
        productTime,
        {
          day1: 55000,
          day3: 42000,
          day7: 30000,
          day30: 15000,
          day90: 5000,
          day180: 1000
        }
      );

      // ======================
      // KEYWORD MATCH (typo tolerant) — prioritize ke liye
      // ======================
      let keywordHits = 0;
      if (remainingTokens.length) {
        const hayTokens =
          (title + " " + searchable)
            .split(/[\s\-|_/,.]+/)
            .filter(Boolean);

        remainingTokens.forEach(qt => {
          if (qt.length < 3) return;
          const hit = hayTokens.some(ht =>
            ht.includes(qt) ||
            (
              Math.abs(qt.length - ht.length) <= 3 &&
              stringSimilarity.compareTwoStrings(qt, ht) >= FUZZY_THRESHOLD
            )
          );
          if (hit) keywordHits++;
        });
      }

      return {
        ...p,
        keywordHits,
        latestTime: productTime,
        latestDate:
          productTime
            ? new Date(productTime)
            : null,
        score
      };
    });

    // brand + keyword: agar keyword-matched products mojood hain to sirf wahi
    // (warna saare brand products — taake empty na rahe)
    if (detectedVendor && remainingTokens.length) {
      const matched = products.filter(p => p.keywordHits > 0);
      if (matched.length) products = matched;
    }

    // =========================
    // 🔥 FINAL PRODUCT SORT
    // =========================

    products.sort((a, b) => {

      if (
        remainingTokens.length &&
        b.keywordHits !== a.keywordHits
      ) {
        return b.keywordHits - a.keywordHits;
      }

      // relevance first
      if (b.score !== a.score) {
        return b.score - a.score;
      }

      return (
        (b.latestTime || latestProductTime(b)) -
        (a.latestTime || latestProductTime(a))
      );

    });
    // =========================
    // 🔥 COLLECTION IDS
    // =========================

    const collectionIds = [
      ...new Set(
        products
          .flatMap(p =>
            Array.isArray(p.collections)
              ? p.collections.map(id => String(id))
              : []
          )
          .flatMap(id => {
            const plain = normalizeId(id);
            return [plain, `gid://shopify/Collection/${plain}`];   // dono format
          })
      )
    ];

    // =========================
    // 🔥 SMART VENDORS
    // =========================

    let vendorResults =

      uniqueVendors

        .filter(v => {

          const vendorName =
            v.toLowerCase();

          // FULL QUERY
          if (
            vendorName.includes(
              normalizedQuery
            )
          ) {
            return true;
          }

          // DETECTED VENDOR
          if (

            detectedVendor &&

            vendorName ===
            detectedVendor.toLowerCase()

          ) {
            return true;
          }

          // TOKEN MATCH
          return remainingTokens.some(
            token =>
              vendorName.includes(
                token
              )
          );

        })

        .map(vendor => {

          // PRODUCTS OF THIS VENDOR
          const vendorProducts =

            products.filter(p =>

              (
                p.vendor || ""
              )
                .toLowerCase()
                .includes(
                  vendor.toLowerCase()
                )

            );

          // LATEST PRODUCT
          const latestProduct =

            [...vendorProducts].sort((a, b) =>
              latestProductTime(b) -
              latestProductTime(a)

            )[0];

          return {

            title:
              vendor,

            type:
              "vendor",

            latestDate:
              latestProduct
                ? new Date(latestProductTime(latestProduct))
                : null,

            score:

              vendorProducts
                .reduce(
                  (acc, p) =>
                    acc + (
                      p.score || 0
                    ),
                  0
                )

          };

        });


    // =========================
    // 🔥 SORT VENDORS
    // =========================

    vendorResults.sort((a, b) => {

      // SCORE FIRST
      if (
        b.score !== a.score
      ) {

        return (
          b.score - a.score
        );
      }

      // THEN LATEST
      return (

        new Date(
          b.latestDate
        ) -

        new Date(
          a.latestDate
        )

      );

    });
    if (detectedVendor) {

      vendorResults = [

        {
          title: detectedVendor,
          type: "vendor",
          score: 999999,
          latestDate: new Date()
        },

        ...vendorResults.filter(
          v =>
            v.title.toLowerCase() !==
            detectedVendor.toLowerCase()
        )

      ];

    }

    // =========================
    // 🔥 COLLECTIONS
    // =========================
    let collections = [];
    if (collectionIds.length) {

      collections =
        await Collection.find({

          store: cleanStore,

          collectionId: {
            $in: collectionIds.map(
              id => String(id)
            )
          }

        })
          .sort({
            firstPublishedAt: -1,
            shopifyCreatedAt: -1
          })
          .limit(50)
          .lean();
    }

    // =========================
    // VENDOR COLLECTION FALLBACK
    // When vendor detected but collections
    // empty (p.collections unpopulated or
    // ID format mismatch in DB)
    // =========================

    if (collections.length === 0 && detectedVendor) {

      const safeVendor = escapeRegex(detectedVendor);

      collections = await Collection.find({

        store: cleanStore,

        $or: [
          { vendor: { $regex: safeVendor, $options: "i" } },
          { searchableText: { $regex: safeVendor, $options: "i" } },
          { title: { $regex: safeVendor, $options: "i" } }
        ]

      })
        .sort({
          firstPublishedAt: -1,
          shopifyCreatedAt: -1
        })
        .limit(20)
        .lean();

    }

    // =========================
    // 🔥 SMART COLLECTIONS
    // =========================

    collections =

      collections.map(c => {

        // RELATED PRODUCTS
        const relatedProducts =
          products.filter(p =>
            Array.isArray(p.collections) &&
            p.collections.some(id =>
              normalizeId(id) === normalizeId(c.collectionId)   // dono side normalize
            )
          );
        // LATEST PRODUCT
        const latestProduct =
          [...relatedProducts].sort((a, b) =>
            latestProductTime(b) -
            latestProductTime(a)
          )[0];

        const topProductScore =
          relatedProducts.length
            ? Math.max(
              ...relatedProducts.map(p => p.score || 0)
            )
            : 0;

        const averageProductScore =
          relatedProducts.length
            ? relatedProducts.reduce(
              (acc, p) => acc + (p.score || 0),
              0
            ) / relatedProducts.length
            : 0;

        let collectionScore =
          Math.min(topProductScore * 0.45, 90000) +
          Math.min(averageProductScore * 0.25, 45000) +
          Math.min(relatedProducts.length * 2500, 20000);

        const title = (c.title || "").toLowerCase();

        const titleVendorMatch =
          detectedVendor ? title.includes(detectedVendor.toLowerCase()) : false;

        if (titleVendorMatch) {
          collectionScore += 60000;
        }

        if (detectedVendor) {

          const vendorMatch =
            (c.searchableText || "")
              .toLowerCase()
              .includes(
                detectedVendor.toLowerCase()
              );

          if (vendorMatch) {
            collectionScore += 35000;
          }

        }

        if (normalizedQuery && title === normalizedQuery) {
          collectionScore += 90000;
        } else if (
          normalizedQuery &&
          title.includes(normalizedQuery)
        ) {
          collectionScore += 45000;
        }

        remainingTokens.forEach(token => {
          if (!token) return;
          if (title.includes(token)) {
            collectionScore += 18000;
          }
          if (
            (c.searchableText || "")
              .toLowerCase()
              .includes(token)
          ) {
            collectionScore += 7000;
          }
        });

        // ======================
        // NEW COLLECTION BOOST
        // ======================

        const collectionTime =
          latestCollectionTime(c);

        const latestProductTimeValue =
          latestProduct
            ? latestProductTime(latestProduct)
            : 0;

        const newestRelatedTime =
          Math.max(
            collectionTime,
            latestProductTimeValue
          );

        collectionScore += recencyScore(
          collectionTime,
          {
            day1: 45000,
            day3: 35000,
            day7: 25000,
            day30: 14000,
            day90: 5000,
            day180: 1000
          }
        );

        collectionScore += recencyScore(
          latestProductTimeValue,
          {
            day1: 35000,
            day3: 28000,
            day7: 20000,
            day30: 10000,
            day90: 3500,
            day180: 800
          }
        );

        if (c.productsCount) {
          collectionScore += Math.min(
            Number(c.productsCount || 0) * 250,
            12000
          );
        }

        if (
          newestRelatedTime &&
          daysSinceTime(newestRelatedTime) > 365
        ) {
          collectionScore -= 25000;
        }

        return {

          ...c,

          titleVendorMatch,

          latestDate:
            newestRelatedTime
              ? new Date(newestRelatedTime)
              : null,
          latestTime:
            newestRelatedTime,
          score: collectionScore
        };

      });


    // =========================
    // 🔥 SORT COLLECTIONS
    // =========================

    // brand detect hua to sirf brand-named collections rakho
    if (detectedVendor) {
      const brandCollections = collections.filter(c => c.titleVendorMatch);
      if (brandCollections.length) {
        collections = brandCollections;
      }
    }

    // Debugging: collection dates check karo
    console.log("COLL DATES:", collections.map(c => ({
      title: c.title,
      created: c.shopifyCreatedAt,
      published: c.shopifyPublishedAt
    })));

    collections.sort((a, b) => {
      // brand-named collections sabse pehle
      if (a.titleVendorMatch !== b.titleVendorMatch) {
        return a.titleVendorMatch ? -1 : 1;
      }

      if ((b.score || 0) !== (a.score || 0)) {
        return (b.score || 0) - (a.score || 0);
      }

      if ((b.latestTime || 0) !== (a.latestTime || 0)) {
        return (b.latestTime || 0) - (a.latestTime || 0);
      }

      return Number(b.productsCount || 0) - Number(a.productsCount || 0);
    });

    // =========================
    // HIDE RANDOM COLLECTIONS
    // =========================

    if (
      products.length === 0 &&
      !detectedVendor
    ) {
      collections = [];
    }

    // =========================
    // 🔥 FORMAT COLLECTIONS
    // =========================
    const formattedCollections =
      collections
        .filter(c => c.title)
        .slice(0, 10)
        .map(c => ({

          title:
            c.title || "",

          handle:
            c.handle || "",

          image:
            c.image || "",

          type:
            "collection",

          score:
            c.score || 0,

          latestDate:
            c.latestDate || null

        }));

    // =========================
    // 🔥 FINAL RESPONSE
    // =========================
    res.json({

      query: q,

      meta: {
        originalQuery,
        finalQuery,
        detectedVendor,
        remainingQuery,
        totalProducts:
          products.length
      },
      vendors:
        vendorResults,
      collections:
        formattedCollections,
      products:
        products
          .slice(0, 20),
      suggestions: []
    });
  } catch (err) {

    res.status(500).json({
      error: err.message
    });
  }
});

router.get("/trending-brands", async (req, res) => {

  try {

    // =========================
    // STORE
    // =========================

    const { store, shop } = req.query;
    const rawStore = store || shop;

    if (!rawStore) {

      return res.status(400)
        .json({
          error: "Store is required"
        });

    }

    const cleanStore = normalizeDomain(rawStore);

    // =========================
    // STORES
    // =========================

    const allStores =
      await Store.find().lean();

    const matchedStores =
      allStores.filter(s => {

        const dbDomain =
          s.domain
            ?.replace(/^https?:\/\//, "")
            .replace(/\/$/, "")
            .trim()
            .toLowerCase();

        return dbDomain === cleanStore;

      });

    if (!matchedStores.length) {

      return res.status(404).json({
        error: "No matching store found",
        cleanStore
      });

    }

    // =========================
    // FEATURED BRANDS
    // =========================

    const featuredBrands =
      await FeaturedBrand.find({
        active: true,
        store: cleanStore
      }).lean();

    const featuredMap = {};

    featuredBrands.forEach(f => {

      if (!f?.title) return;

      featuredMap[
        f.title.toLowerCase()
      ] = f;

    });

    // =========================
    // ANALYTICS DATA
    // =========================

    const analyticsData =
      await Analytics.aggregate([

        {
          $match: {
            store: cleanStore,
            vendor: {
              $exists: true,
              $ne: null
            }
          }
        },

        {
          $group: {

            _id: "$vendor",

            searches: {
              $sum: {
                $cond: [
                  {
                    $eq: [
                      "$type",
                      "search"
                    ]
                  },
                  1,
                  0
                ]
              }
            },

            clicks: {
              $sum: {
                $cond: [
                  {
                    $eq: [
                      "$type",
                      "click"
                    ]
                  },
                  1,
                  0
                ]
              }
            }

          }
        }

      ]);

    const analyticsMap = {};

    analyticsData.forEach(a => {

      if (!a?._id) return;

      analyticsMap[
        a._id.toLowerCase()
      ] = a;

    });

    // =========================
    // FETCH PRODUCTS
    // =========================

    const results =
      await Promise.all(

        matchedStores.map(async storeDoc => {

          try {

            const cleanDomain =
              storeDoc.domain
                ?.replace(/^https?:\/\//, "")
                .replace(/\/$/, "");

            const response =
              await fetch(

                `https://${cleanDomain}/admin/api/2026-04/graphql.json`,

                {
                  method: "POST",

                  headers: {
                    "X-Shopify-Access-Token":
                      storeDoc.accessToken,

                    "Content-Type":
                      "application/json",
                  },

                  body: JSON.stringify({

                    query: `
{
  products(
    first: 60,
    sortKey: CREATED_AT,
    reverse: true,
    query: "status:active"
  ) {

    edges {

      node {
        id
        vendor
        title
        handle
        createdAt
        updatedAt
        publishedAt
        status

        images(first:1){
          edges{
            node{
              url
            }
          }
        }

        variants(first:1){
          edges{
            node{
              price
            }
          }
        }

      }

    }

  }
}
                    `,

                  }),
                }
              );

            const data =
              await response.json();

            if (
              data?.errors
            ) {

              console.log(
                "SHOPIFY GRAPHQL ERROR:",
                data.errors
              );

              return [];

            }

            return (

              data?.data?.products?.edges?.map(p => ({

                id:
                  p.node.id || "",

                title:
                  p.node.title || "",

                handle:
                  p.node.handle || "",

                vendor:
                  p.node.vendor || "",

                createdAt:
                  p.node.createdAt || null,

                updatedAt:
                  p.node.updatedAt || null,

                publishedAt:
                  p.node.publishedAt || null,

                status:
                  p.node.status || "",

                timestamp:
                  new Date(
                    p.node.publishedAt ||
                    p.node.createdAt ||
                    0
                  ).getTime(),

                image:
                  p.node.images
                    ?.edges?.[0]
                    ?.node?.url || "",

                price:
                  Number(
                    p.node.variants?.edges?.[0]
                      ?.node?.price || 0
                  ),

              })) || []

            );

          } catch (err) {

            console.error(
              "STORE FETCH ERROR:",
              storeDoc.domain,
              err.message
            );

            return [];

          }

        })

      );

    // =========================
    // PRODUCTS
    // =========================

    const products =
      results
        .flat()
        .filter(p =>

          p.status === "ACTIVE" &&
          p.publishedAt

        );

    const productIds =
      products.map(p => p.id).filter(Boolean);

    const productFreshnessDocs =
      productIds.length
        ? await Product.find({
          store: cleanStore,
          productId: { $in: productIds }
        })
          .select("productId firstPublishedAt shopifyCreatedAt")
          .lean()
        : [];

    const productFreshnessMap = {};

    productFreshnessDocs.forEach(p => {
      productFreshnessMap[String(p.productId)] = p;
    });

    products.forEach(p => {
      const dbProduct =
        productFreshnessMap[String(p.id)];

      p.firstPublishedAt =
        dbProduct?.firstPublishedAt || null;

      p.shopifyCreatedAt =
        dbProduct?.shopifyCreatedAt ||
        p.createdAt ||
        null;

      p.stableTime =
        latestProductTime(p);
    });

    // =========================
    // GROUP BRANDS
    // =========================

    const brandMap = {};

    products.forEach(product => {

      const vendor =
        product.vendor?.trim();

      if (!vendor) return;

      if (!brandMap[vendor]) {

        brandMap[vendor] = {

          title: vendor,
          products: [],
          latestDate: null,
          score: 0

        };

      }

      brandMap[vendor]
        .products
        .push(product);

    });

    // =========================
    // CALCULATE SCORES
    // =========================

    Object.values(brandMap)
      .forEach(brand => {

        const latestProduct =

          [...brand.products]

            .sort((a, b) =>

              (b.stableTime || 0) -
              (a.stableTime || 0)

            )[0];

        // =========================
        // LATEST DATE
        // =========================

        brand.latestDate =
          latestProduct?.stableTime
            ? new Date(latestProduct.stableTime)
            : null;

        brand.latestTime =
          latestProduct?.stableTime || 0;

        // =========================
        // BASE SCORE
        // =========================

        brand.score +=
          Math.min(
            brand.products.length * 100,
            3000
          );

        // =========================
        // ANALYTICS BOOST
        // =========================

        const analyticsBrand =

          analyticsMap[
          brand.title?.toLowerCase()
          ];

        if (analyticsBrand) {

          brand.score += Math.min(
            (analyticsBrand.searches || 0) * 80 +
            (analyticsBrand.clicks || 0) * 200,
            12000
          );

        }

        // =========================
        // RECENCY BOOST
        // =========================

        if (latestProduct?.stableTime) {

          const latestDate =
            latestProduct.stableTime;

          const daysOld =
            (
              Date.now() -
              latestDate
            ) /
            (1000 * 60 * 60 * 24);

          if (daysOld <= 1) {
            brand.score += 45000;
          } else if (daysOld <= 3) {
            brand.score += 35000;
          } else if (daysOld <= 7) {
            brand.score += 25000;
          } else if (daysOld <= 30) {
            brand.score += 12000;
          } else if (daysOld <= 90) {
            brand.score += 4000;
          } else if (daysOld > 365) {
            brand.score -= 15000;
          } else if (daysOld > 180) {
            brand.score -= 6000;
          }
        }
        // =========================
        // FEATURED BOOST
        // =========================

        const featured =

          featuredMap[
          brand.title?.toLowerCase()
          ];

        if (featured) {

          brand.score +=
            12000 +
            Math.min(featured.priority || 0, 8000);

        }

      });

    // =========================
    // FINAL BRANDS
    // =========================

    const brands =

      Object.values(brandMap)

        .sort((a, b) => {
          if (b.score !== a.score) {
            return b.score - a.score;
          }

          return (b.latestTime || 0) - (a.latestTime || 0);
        })

        .slice(0, 10)

        .map(b => ({

          title:
            b.title,

          score:
            b.score,

          latestDate:
            b.latestDate,

          totalProducts:
            b.products.length

        }));

    // =========================
    // TRENDING PRODUCTS
    // =========================

    const trendingProducts =

      [...products]

        .sort((a, b) =>

          (b.stableTime || 0) -
          (a.stableTime || 0)

        )

        .slice(0, 80);

    // =========================
    // RESPONSE
    // =========================

    res.json({

      brands,
      products:
        trendingProducts

    });

  } catch (err) {

    console.error(
      "TRENDING BRANDS ERROR:",
      err
    );

    res.status(500).json({
      error: err.message
    });

  }

});

router.get("/trending", async (req, res) => {

  try {

    // =========================
    // STORE
    // =========================

    const { store, shop } = req.query;
    const rawStore = store || shop;

    if (!rawStore) {

      return res.status(400).json({
        error: "Store is required"
      });

    }

    // =========================
    // CLEAN STORE
    // =========================

    const cleanStore = normalizeDomain(rawStore);

    // =========================
    // MATCH STORE
    // =========================

    const matchedStores =
      await Store.find({
        domain: {
          $regex: new RegExp(
            `^${escapeRegex(cleanStore)}$`,
            "i"
          )
        }
      }).lean();

    if (!matchedStores.length) {

      return res.json([]);

    }

    // =========================
    // FETCH PRODUCTS
    // =========================

    const results =
      await Promise.all(

        matchedStores.map(async (shopStore) => {

          try {

            const cleanDomain =
              shopStore.domain
                .replace(/^https?:\/\//, "")
                .replace(/\/$/, "");

            const response =
              await fetch(

                `https://${cleanDomain}/admin/api/2026-04/graphql.json`,

                {
                  method: "POST",

                  headers: {

                    "X-Shopify-Access-Token":
                      shopStore.accessToken,

                    "Content-Type":
                      "application/json",

                  },

                  body: JSON.stringify({

                    query: `
                    {
                      products(
                        first: 60,
                        sortKey: CREATED_AT,
                        reverse: true,
                        query: "status:active"
                      ) {

                        edges {

                          node {

                            id
                            title
                            handle
                            vendor
                            createdAt
                            updatedAt
                            publishedAt
                            status

                            images(first: 1) {
                              edges {
                                node {
                                  url
                                }
                              }
                            }

                            variants(first: 1) {
                              edges {
                                node {
                                  price
                                }
                              }
                            }

                          }

                        }

                      }
                    }
                    `,

                  }),

                }

              );

            const data =
              await response.json();

            // =========================
            // GRAPHQL ERROR DEBUG
            // =========================

            if (data?.errors) {

              console.error(
                "SHOPIFY GRAPHQL ERROR:",
                cleanDomain,
                data.errors
              );

              return [];

            }

            const products =
              data?.data?.products?.edges || [];

            return products.map(({ node }) => ({

              id:
                node?.id || "",

              title:
                node?.title || "",

              handle:
                node?.handle || "",

              vendor:
                node?.vendor || "",

              createdAt:
                node?.createdAt || null,

              updatedAt:
                node?.updatedAt || null,

              publishedAt:
                node?.publishedAt || null,

              status:
                node?.status || "",

              timestamp:
                new Date(
                  node?.publishedAt ||
                  node?.createdAt ||
                  0
                ).getTime(),

              image:
                node?.images?.edges?.[0]
                  ?.node?.url || "",

              price:
                Number(
                  node?.variants?.edges?.[0]
                    ?.node?.price || 0
                ),

              store:
                cleanDomain,

            }));

          } catch (err) {

            console.error(
              "TRENDING FETCH ERROR:",
              shopStore.domain,
              err.message
            );

            return [];

          }

        })

      );

    // =========================
    // ANALYTICS
    // =========================

    const analyticsData =
      await Analytics.aggregate([

        {
          $match: {

            store: cleanStore,

            productId: {
              $exists: true,
              $ne: null
            }

          }
        },

        {
          $group: {

            _id: "$productId",

            clicks: {
              $sum: {
                $cond: [
                  {
                    $eq: [
                      "$type",
                      "click"
                    ]
                  },
                  1,
                  0
                ]
              }
            },

            searches: {
              $sum: {
                $cond: [
                  {
                    $eq: [
                      "$type",
                      "search"
                    ]
                  },
                  1,
                  0
                ]
              }
            }

          }

        }

      ]);

    // =========================
    // ANALYTICS MAP
    // =========================

    const analyticsMap = {};

    analyticsData.forEach(item => {

      analyticsMap[item._id] = item;

    });

    // =========================
    // PRODUCTS
    // =========================

    let products =
      results
        .flat()
        .filter(product => {

          return (
            product.status === "ACTIVE" &&
            product.publishedAt &&
            product.handle
          );

        });

    const productIds =
      products.map(p => p.id).filter(Boolean);

    const productFreshnessDocs =
      productIds.length
        ? await Product.find({
          store: cleanStore,
          productId: { $in: productIds }
        })
          .select("productId firstPublishedAt shopifyCreatedAt")
          .lean()
        : [];

    const productFreshnessMap = {};

    productFreshnessDocs.forEach(p => {
      productFreshnessMap[String(p.productId)] = p;
    });

    products.forEach(product => {
      const dbProduct =
        productFreshnessMap[String(product.id)];

      product.firstPublishedAt =
        dbProduct?.firstPublishedAt || null;

      product.shopifyCreatedAt =
        dbProduct?.shopifyCreatedAt ||
        product.createdAt ||
        null;

      product.stableTime =
        latestProductTime(product);
    });

    products.sort(
      (a, b) =>
        (b.stableTime || 0) -
        (a.stableTime || 0)
    );

    // =========================
    // REMOVE DUPLICATES
    // =========================

    const uniqueMap = new Map();

    products.forEach(product => {

      if (
        !uniqueMap.has(product.id)
      ) {

        uniqueMap.set(
          product.id,
          product
        );

      }

    });

    products =
      [...uniqueMap.values()];

    // =========================
    // SCORE PRODUCTS
    // =========================

    const scoredProducts =
      products.map(product => {

        let score = 0;

        // =========================
        // ANALYTICS SCORE
        // =========================

        const analytics =
          analyticsMap[
          product.id
          ];

        if (analytics) {

          score += Math.min(
            (analytics.clicks || 0) * 2500 +
            (analytics.searches || 0) * 1000,
            120000
          );

          // LOW ENGAGEMENT PENALTY
          if (
            (analytics.clicks || 0) < 2 &&
            (analytics.searches || 0) < 2
          ) {

            score -= 1000;

          }

        }

        // =========================
        // RECENCY BOOST
        // =========================

        const daysOld =
          (
            Date.now() -
            (product.stableTime || 0)
          ) / (1000 * 60 * 60 * 24);

        if (daysOld <= 3) {

          score += 800000;

        } else if (daysOld <= 7) {

          score += 500000;

        } else if (daysOld <= 30) {

          score += 250000;

        } else if (daysOld <= 90) {

          score += 100000;

        } else if (daysOld <= 180) {

          score += 30000;

        } else if (daysOld > 365) {

          score -= 30000;

        }

        return {

          ...product,
          score

        };

      });

    // =========================
    // FINAL PRODUCTS
    // =========================

    const trendingProducts =
      scoredProducts

        .sort((a, b) => {
          if (b.score !== a.score) {
            return b.score - a.score;
          }

          return (b.stableTime || 0) - (a.stableTime || 0);
        })

        .slice(0, 12);

    // =========================
    // RESPONSE
    // =========================

    res.json(
      trendingProducts
    );

  } catch (err) {

    console.error(
      "TRENDING PRODUCTS ERROR:",
      err
    );

    res.status(500).json({
      error: err.message
    });

  }

});

router.get("/trending-collections", async (req, res) => {
  try {
    const { store, shop } = req.query;
    const rawStore = store || shop;

    if (!rawStore) {
      return res.json({ collections: [] });
    }

    // /trending jaisa store match
    const cleanStore = normalizeDomain(rawStore);

    const matchedStores = await Store.find({
      domain: {
        $regex: new RegExp(`^${escapeRegex(cleanStore)}$`, "i")
      }
    }).lean();

    if (!matchedStores.length) {
      return res.json({ collections: [] });
    }

    // fetch latest 20 collections for the store, sort by firstPublishedAt desc
    const collections = await Collection.find({
      store: cleanStore
    })
      .sort({
        firstPublishedAt: -1,
        shopifyCreatedAt: -1
      })
      .limit(20)
      .lean();

    const formattedCollections =
      collections
        .filter(c =>
          c.handle &&
          c.title &&
          c.title.trim() &&
          c.title !== "."
        )
        .slice(0, 10)
        .map(c => ({
          title: c.title,
          handle: c.handle,
          image: c.image || ""
        }));

    console.log(
      "DB COLLECTIONS:",
      collections.length
    );

    console.log(
      "COLLECTION TITLES:",
      formattedCollections.map(
        c => c.title
      )
    );

    return res.json({
      collections: formattedCollections
    });

  } catch (err) {
    console.error("TRENDING COLLECTIONS ERROR:", err);
    res.status(500).json({ collections: [] });
  }
});


module.exports = router;
