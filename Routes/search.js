const express = require("express");
const router = express.Router();
const fetch = require("node-fetch");
const Store = require('../Models/store')
const Analytics = require("../Models/analyticsModel");
const Synonym = require("../Models/synonymModel");
const Boost = require("../Models/boostModel");
const Product = require("../Models/productModel")
const Collection = require("../Models/collectionModel");

const SHOPIFY_URL = `${process.env.SHOPIFY_STORE_URL}/api/graphql.json`;

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
  1000 * 60 * 10; // 10 min

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

    q = (q || "").trim();

    const originalQuery =
      q.toLowerCase();

    if (!q || !shop) {

      return res.json({
        query: q,
        meta: {},
        vendors: [],
        collections: [],
        products: [],
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

      console.log(
        "Original Query:",
        originalQuery
      );

      finalQuery =
        synonymData.synonyms[0]
          .toLowerCase()
          .trim();

      console.log(
        "Synonym Applied:",
        finalQuery
      );
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

    console.log(
      "Boosted IDs:",
      boostedIds
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

        data:
          uniqueVendors,

        timestamp:
          Date.now()

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
    // 🔥 DETECT VENDOR
    // =========================
    let detectedVendor = null;

    // LONGEST MATCH FIRST
    const sortedVendors =
      [...uniqueVendors].sort(
        (a, b) =>
          b.length - a.length
      );

    detectedVendor =
      sortedVendors.find(v =>

        normalizedQuery.startsWith(
          v.toLowerCase()
        )

      );

    // =========================
    // 🔥 REMAINING QUERY
    // =========================
    let remainingQuery = "";

    if (detectedVendor) {

      remainingQuery =
        normalizedQuery

          .replace(
            detectedVendor.toLowerCase(),
            ""
          )

          .trim();
    }

    console.log(
      "Detected Vendor:",
      detectedVendor
    );

    console.log(
      "Remaining Query:",
      remainingQuery
    );

    // =========================
    // 🔥 SMART VENDOR SUGGESTIONS
    // =========================
    const matchedVendors =

      uniqueVendors

        .filter(v =>

          v
            .toLowerCase()
            .startsWith(
              normalizedQuery
            )

        )

        .slice(0, 10)

        .map(v => ({

          title: v,

          handle:
            v
              .toLowerCase()
              .replace(/\s+/g, "-"),

          type: "vendor",

          score: 100

        }));

    // =========================
    // 🔥 TOKENIZE QUERY
    // =========================
    const tokens =
      normalizedQuery

        .split(" ")

        .map(t => t.trim())

        .filter(Boolean);

    // =========================
    // 🔥 SMART SEARCH CONDITIONS
    // =========================
    let searchConditions = [];

    if (detectedVendor) {

      // ✅ VENDOR MATCH
      searchConditions.push({

        vendor: {
          $regex:
            detectedVendor,
          $options: "i"
        }

      });

      // ✅ REMAINING QUERY
      if (remainingQuery) {

        const remainingTokens =
          remainingQuery

            .split(" ")

            .filter(Boolean);

        searchConditions.push({

          $or: [

            // TOKEN TITLE MATCHES
            ...remainingTokens.map(t => ({

              title: {
                $regex: t,
                $options: "i"
              }

            })),

            // SEARCHABLE TEXT
            {
              searchableText:
                new RegExp(
                  remainingQuery,
                  "i"
                )
            },

            // TAGS
            {
              tags: {
                $regex:
                  remainingQuery,
                $options: "i"
              }
            },

            // COLLECTIONS
            {
              collections: {
                $regex:
                  remainingQuery,
                $options: "i"
              }
            }

          ]

        });
      }

    } else {

      // =========================
      // 🔥 NORMAL SEARCH
      // =========================
      searchConditions.push({

        $or: [

          {
            title:
              new RegExp(
                normalizedQuery,
                "i"
              )
          },

          {
            vendor:
              new RegExp(
                normalizedQuery,
                "i"
              )
          },

          {
            productType:
              new RegExp(
                normalizedQuery,
                "i"
              )
          },

          {
            searchableText:
              new RegExp(
                normalizedQuery,
                "i"
              )
          },

          {
            tags: {
              $regex:
                normalizedQuery,
              $options: "i"
            }
          },

          {
            collections: {
              $regex:
                normalizedQuery,
              $options: "i"
            }
          }

        ]

      });
    }

    // =========================
    // 🔥 SEARCH PRODUCTS
    // =========================
    let products =
      await Product.find({

        store: shop,

        status: "ACTIVE",

        $and: searchConditions

      })

        .limit(250)

        .lean();

    // =========================
    // 🔥 FORMAT + SCORE PRODUCTS
    // =========================
    products = products.map(p => {

      let score = 0;

      const title =
        (p.title || "")
          .toLowerCase();

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
        score += 50000;
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

        score += 80000;

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

        score += 30000;

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

      const created =
        new Date(
          p.createdAt ||
          p.shopifyCreatedAt
        );

      const daysOld =
        (
          Date.now() -
          created.getTime()
        ) /
        (1000 * 60 * 60 * 24);

      // 2026 / NEWEST PRODUCTS
      if (daysOld <= 7) {

        score += 100000;

      } else if (
        daysOld <= 30
      ) {

        score += 70000;

      } else if (
        daysOld <= 90
      ) {

        score += 40000;

      } else if (
        daysOld <= 180
      ) {

        score += 20000;

      }

      return {
        ...p,
        score
      };

    });

    // =========================
    // 🔥 SORT PRODUCTS
    // =========================

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
        b.createdAt ||
        b.shopifyCreatedAt
      ) -

      new Date(
        a.createdAt ||
        a.shopifyCreatedAt
      ));

    // =========================
    // 🔥 COLLECTIONS
    // =========================
    let collectionQuery = {

      store: shop

    };

    // =========================
    // VENDOR COLLECTIONS
    // =========================

    if (detectedVendor) {

      collectionQuery.$or = [

        {
          vendor: {
            $regex:
              detectedVendor,
            $options: "i"
          }
        },

        {
          title: {
            $regex:
              detectedVendor,
            $options: "i"
          }
        }

      ];

    } else {

      collectionQuery.$or = [

        {
          title: {
            $regex:
              normalizedQuery,
            $options: "i"
          }
        },

        {
          handle: {
            $regex:
              normalizedQuery,
            $options: "i"
          }
        }

      ];

    }

    let collections =
      await Collection.find(
        collectionQuery
      )

        .sort({
          shopifyCreatedAt: -1
        })

        .limit(10)

        .lean();

    // =========================
    // 🔥 FORMAT COLLECTIONS
    // =========================
    const formattedCollections =

      collections.map(c => ({

        title:
          c.title || "",

        handle:
          c.handle || "",

        image:
          c.image || "",

        type:
          "collection",

        score: 80

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
        matchedVendors,

      collections:
        formattedCollections,

      products,

      suggestions: []

    });

  } catch (err) {

    console.log(
      "SERVER ERROR:",
      err
    );

    res.status(500).json({

      error: err.message

    });
  }
});

router.get("/trending-brands", async (req, res) => {
  try {
    const stores = await Store.find();

    const results = await Promise.all(
      stores.map(async (store) => {
        const response = await fetch(
          `https://${store.domain}/admin/api/2024-01/graphql.json`,
          {
            method: "POST",
            headers: {
              "X-Shopify-Access-Token": store.accessToken,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              query: `
              {
                products(first: 10) {
                  edges {
                    node {
                      vendor
                      title
                      handle
                      images(first:1){
                        edges{node{url}}
                      }
                      variants(first:1){
                        edges{node{price}}
                      }
                    }
                  }
                }
              }
              `,
            }),
          }
        );

        const data = await response.json();

        return data?.data?.products?.edges?.map(p => ({
          title: p.node.title,
          handle: p.node.handle,
          vendor: p.node.vendor,
          image: p.node.images?.edges?.[0]?.node?.url || "",
          price: p.node.variants?.edges?.[0]?.node?.price || "0",
        })) || [];

      })
    );

    const products = results.flat();

    const brands = [...new Set(products.map(p => p.vendor).filter(Boolean))];

    res.json({
      products,
      brands
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/trending", async (req, res) => {
  try {
    const stores = await Store.find();

    const promises = stores.map(async (store) => {
      try {
        const cleanDomain = store.domain.replace(/\/$/, "");

        const response = await fetch(
          `https://${cleanDomain}/admin/api/2024-01/graphql.json`,
          {
            method: "POST",
            headers: {
              "X-Shopify-Access-Token": store.accessToken,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              query: `
              {
                products(first: 6, sortKey: CREATED_AT, reverse: true) {
                  edges {
                    node {
                      id
                      title
                      handle
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

        const data = await response.json();

        return (
          data?.data?.products?.edges?.map((item) => {
            const node = item.node;

            return {
              id: node.id,
              title: node.title,
              handle: node.handle,

              image: node.images?.edges?.[0]?.node?.url || "",
              price: node.variants?.edges?.[0]?.node?.price || "0",

              store: cleanDomain,
            };
          }) || []
        );
      } catch (err) {
        console.log("TRENDING ERROR:", store.domain);
        return [];
      }
    });

    const results = await Promise.all(promises);
    res.json(results.flat());

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;