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
            shopifyPublishedAt: -1,
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

            if (sim > 0.75) {
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
      vendorMatches[0].score > 15000
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

        vendor: {
          $regex:
            detectedVendor,
          $options: "i"
        }

      });

      // ✅ REMAINING QUERY
      if (remainingQuery) {

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
        store: cleanStore,
        status: "ACTIVE",
        $and: searchConditions
      })
        .sort({
          shopifyPublishedAt: -1,
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
      products.length < 20 &&
      detectedVendor
    ) {
      const fallbackProducts =
        await Product.find({
          store: cleanStore,
          status: "ACTIVE",
          vendor: {
            $regex: detectedVendor,
            $options: "i"
          }
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

          if (sim > 0.75) {
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

      const productDate =

        p.shopifyPublishedAt ||
        p.shopifyCreatedAt ||

        p.createdAt;

      const created =
        productDate
          ? new Date(productDate)
          : null;

      const daysOld =
        created
          ? (
            Date.now() -
            created.getTime()
          ) /
          (1000 * 60 * 60 * 24)
          : 9999;

      // 2026 / NEWEST PRODUCTS
      // VERY NEW
      if (daysOld <= 1) {
        score += 120000;
      } else if (daysOld <= 3) {
        score += 80000;
      } else if (daysOld <= 7) {
        score += 50000;
      } else if (daysOld <= 30) {
        score += 20000;
      } else if (daysOld <= 90) {
        score += 5000;
      }

      return {
        ...p,
        score
      };

    });
    // =========================
    // 🔥 FINAL PRODUCT SORT
    // =========================

    products.sort((a, b) => {

      // SCORE FIRST
      if (b.score !== a.score) {
        return b.score - a.score;
      }

      // THEN PUBLISHED DATE
      return (
        new Date(
          b.shopifyPublishedAt ||
          b.shopifyCreatedAt ||
          b.createdAt ||
          0
        ) -

        new Date(
          a.shopifyPublishedAt ||
          a.shopifyCreatedAt ||
          a.createdAt ||
          0
        )
      );

    });

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

              new Date(

                b.shopifyPublishedAt ||
                b.shopifyCreatedAt ||
                b.createdAt ||
                0

              ) -

              new Date(

                a.shopifyPublishedAt ||
                a.shopifyCreatedAt ||
                a.createdAt ||
                0

              )

            )[0];

          return {

            title:
              vendor,

            type:
              "vendor",

            latestDate:

              latestProduct
                ?.shopifyCreatedAt ||

              latestProduct
                ?.createdAt ||

              0,

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

    // =========================
    // 🔥 COLLECTIONS
    // =========================
    let collectionQuery = {
      store: cleanStore
    };

    // =========================
    // =========================
    // VENDOR COLLECTIONS
    // =========================

    if (detectedVendor) {

      if (remainingQuery) {

        collectionQuery = {
          store: cleanStore,
          $and: [
            {
              searchableText: {
                $regex: detectedVendor,
                $options: "i"
              }
            },
            {
              searchableText: {
                $regex: remainingQuery,
                $options: "i"
              }
            }
          ]
        };

      } else {

        collectionQuery = {
          store: cleanStore,
          searchableText: {
            $regex: detectedVendor,
            $options: "i"
          }
        };

      }

    } else {

      collectionQuery.$or = [

        {
          title: {
            $regex: normalizedQuery,
            $options: "i"
          }
        },

        {
          handle: {
            $regex: normalizedQuery,
            $options: "i"
          }
        },

        {
          searchableText: {
            $regex: normalizedQuery,
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
          shopifyPublishedAt: -1,
          shopifyCreatedAt: -1
        })

        .limit(20)

        .lean();

    // =========================
    // 🔥 SMART COLLECTIONS
    // =========================

    collections =

      collections.map(c => {

        // RELATED PRODUCTS
        const relatedProducts =

          products.filter(p => {

            const productCollections =

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

            const collectionTitle =
              (
                c.title || ""
              ).toLowerCase();

            const collectionTokens =
              collectionTitle
                .split(" ")
                .filter(Boolean);

            return collectionTokens.some(
              token =>
                productCollections.includes(
                  token
                )
            );

          });
        // LATEST PRODUCT
        const latestProduct =

          [...relatedProducts].sort((a, b) =>

            new Date(

              b.shopifyPublishedAt ||
              b.shopifyCreatedAt ||
              b.createdAt ||

              0

            ) -

            new Date(
              a.shopifyPublishedAt ||
              a.shopifyCreatedAt ||
              a.createdAt ||
              0
            )

          )[0];

        let collectionScore =

          relatedProducts.reduce(
            (acc, p) =>
              acc + (p.score || 0),
            0
          );

        if (detectedVendor) {

          const vendorMatch =
            (c.searchableText || "")
              .toLowerCase()
              .includes(
                detectedVendor.toLowerCase()
              );

          if (vendorMatch) {
            collectionScore += 100000;
          }

        }

        // ======================
        // NEW COLLECTION BOOST
        // ======================

        const collectionDate =

          new Date(
            c.shopifyCreatedAt ||
            c.createdAt ||
            0
          );

        const collectionDaysOld =

          (
            Date.now() -
            collectionDate.getTime()
          ) /

          (1000 * 60 * 60 * 24);

        if (collectionDaysOld <= 7) {

          collectionScore += 50000;

        } else if (
          collectionDaysOld <= 30
        ) {

          collectionScore += 25000;

        } else if (
          collectionDaysOld <= 90
        ) {

          collectionScore += 10000;

        }

        return {

          ...c,

          latestDate:
            latestProduct?.shopifyPublishedAt ||
            latestProduct?.shopifyCreatedAt ||
            latestProduct?.createdAt ||
            c.shopifyCreatedAt ||
            c.createdAt ||
            0,
          score: collectionScore
        };

      });


    // =========================
    // 🔥 SORT COLLECTIONS
    // =========================

    collections.sort((a, b) => {

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

    // =========================
    // 🔥 FORMAT COLLECTIONS
    // =========================
    const formattedCollections =
      collections
        .filter(c => c.title && c.handle)
        .slice(0, 5)
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

              b.timestamp -
              a.timestamp

            )[0];

        // =========================
        // LATEST DATE
        // =========================

        brand.latestDate =
          latestProduct?.publishedAt ||
          latestProduct?.createdAt ||
          null;

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

          brand.score +=
            analyticsBrand.searches * 120;

          brand.score +=
            analyticsBrand.clicks * 250;

        }

        // =========================
        // RECENCY BOOST
        // =========================

        if (latestProduct?.publishedAt || latestProduct?.createdAt) {

          const latestDate =
            latestProduct.publishedAt ||
            latestProduct.createdAt ||
            latestProduct.shopifyCreatedAt;

          const daysOld =
            (
              Date.now() -
              new Date(latestDate).getTime()
            ) /
            (1000 * 60 * 60 * 24);

          if (daysOld <= 1) {
            brand.score += 20000;
          } else if (daysOld <= 3) {
            brand.score += 15000;
          } else if (daysOld <= 7) {
            brand.score += 10000;
          } else if (daysOld <= 30) {
            brand.score += 5000;
          } else if (daysOld <= 90) {
            brand.score += 1000;
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
            30000 +
            (featured.priority || 0);

        }

      });

    // =========================
    // FINAL BRANDS
    // =========================

    const brands =

      Object.values(brandMap)

        .sort((a, b) =>

          b.score - a.score

        )

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

          b.timestamp -
          a.timestamp

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

    products.sort(
      (a, b) => b.timestamp - a.timestamp
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

          // CLICK BOOST
          score +=
            (analytics.clicks || 0) * 3000;

          // SEARCH BOOST
          score +=
            (analytics.searches || 0) * 1200;

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
            product.timestamp
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

        .sort((a, b) =>
          b.score - a.score
        )

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

module.exports = router;