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
    const cleanStore = shop;
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
    // 🔥 DETECT PARTIAL VENDOR
    // =========================

    let detectedVendor =

      uniqueVendors.find(v => {

        const vendorName =
          v.toLowerCase();

        // FULL QUERY MATCH
        if (
          vendorName.includes(
            normalizedQuery
          )
        ) {
          return true;
        }

        // QUERY INSIDE VENDOR
        if (
          normalizedQuery.includes(
            vendorName
          )
        ) {
          return true;
        }

        // TOKEN MATCH
        return normalizedQuery

          .split(" ")

          .some(token =>

            token.length >= 2 &&

            vendorName.includes(
              token
            )

          );

      });

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

        .limit(40)

        .lean()
        .select(`
  title
  handle
  vendor
  image
  price
  createdAt
  shopifyCreatedAt
  collections
  searchableText
  tags
`)

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
      // VERY NEW
      if (daysOld <= 7) {

        score += 2000000;

      } else if (
        daysOld <= 30
      ) {

        score += 1200000;

      } else if (
        daysOld <= 90
      ) {

        score += 500000;

      } else if (
        daysOld <= 180
      ) {

        score += 100000;

      } else {

        score -= 50000;

      }

      return {
        ...p,
        score
      };

    });

    // =========================
    // 🔥 SORT PRODUCTS
    // =========================

    products.sort((a, b) => {

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
          b.createdAt ||
          b.shopifyCreatedAt
        ) -

        new Date(
          a.createdAt ||
          a.shopifyCreatedAt
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

            vendorName.includes(
              detectedVendor
                .toLowerCase()
            )

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
                b.createdAt ||
                b.shopifyCreatedAt
              ) -

              new Date(
                a.createdAt ||
                a.shopifyCreatedAt
              )

            )[0];

          return {

            title:
              vendor,

            type:
              "vendor",

            latestDate:

              latestProduct
                ?.createdAt ||

              latestProduct
                ?.shopifyCreatedAt ||

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
          score: -1,
          createdAt: -1
        })

        .limit(10)

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
              b.createdAt ||
              b.shopifyCreatedAt
            ) -

            new Date(
              a.createdAt ||
              a.shopifyCreatedAt
            )

          )[0];

        return {

          ...c,

          latestDate:

            latestProduct
              ?.createdAt ||

            latestProduct
              ?.shopifyCreatedAt ||

            0,

          score:

            relatedProducts
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
        vendorResults,
      collections:
        formattedCollections,
      products:
        products.slice(0, 20),
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
    // STORES
    // =========================

    const { store } =
      req.query;

    if (!store) {

      return res.status(400)
        .json({
          error:
            "Store is required"
        });

    }

    const cleanStore =
      store
        .replace(/^https?:\/\//, "")
        .replace(/\/$/, "")
        .trim()
        .toLowerCase();

    const stores =
      await Store.find({
        domain: new RegExp(
          `^${cleanStore}$`,
          "i"
        )
      }).lean();

    // FEATURED BRANDS

    const featuredBrands =
      await FeaturedBrand.find({
        active: true,
        store: cleanStore
      }).lean();

    // FEATURED MAP
    const featuredMap = {};
    featuredBrands.forEach(f => {
      featuredMap[
        f.title?.toLowerCase()
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

    // =========================
    // ANALYTICS MAP
    // =========================

    const analyticsMap = {};

    analyticsData.forEach(a => {

      if (!a._id) return;

      analyticsMap[
        a._id.toLowerCase()
      ] = a;

    });

    // =========================
    // FETCH PRODUCTS
    // =========================

    const results =
      await Promise.all(

        stores.map(async store => {

          try {

            const response =
              await fetch(

                `https://${store.domain}/admin/api/2024-01/graphql.json`,

                {
                  method: "POST",

                  headers: {
                    "X-Shopify-Access-Token":
                      store.accessToken,

                    "Content-Type":
                      "application/json",
                  },

                  body: JSON.stringify({

                    query: `
{
  products(
  first: 50,
  sortKey: UPDATED_AT,
  reverse: true,
  query: "status:ACTIVE"
) {
    edges {
      node {
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

            return (

              data?.data?.products?.edges?.map(p => ({

                title:
                  p.node.title || "",
                handle:
                  p.node.handle || "",
                vendor:
                  p.node.vendor || "",
                createdAt:
                  p.node.createdAt || null,
                publishedAt:
                  p.node.publishedAt || null,
                status:
                  p.node.status || "",
                updatedAt:
                  p.node.updatedAt || null,
                timestamp:
                  new Date(
                    p.node.updatedAt ||
                    p.node.createdAt ||
                    0
                  ).getTime(),
                image:
                  p.node.images
                    ?.edges?.[0]
                    ?.node?.url || "",

                price:
                  p.node.variants
                    ?.edges?.[0]
                    ?.node?.price || "0",

              })) || []

            );

          } catch (err) {

            console.error(
              "STORE FETCH ERROR:",
              store.domain,
              err.message
            );

            return [];

          }

        })

      );

    // =========================
    // PRODUCTS
    // =========================

    let products =
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

          title:
            vendor,

          products: [],

          latestDate:
            product.createdAt,

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
          latestProduct?.updatedAt ||
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
          brand.title.toLowerCase()
          ];
        if (analyticsBrand) {
          // SEARCH BOOST
          brand.score +=
            analyticsBrand.searches * 120;

          brand.score +=
            analyticsBrand.clicks * 250;
        }

        // =========================
        // RECENCY BOOST
        // =========================

        if (
          latestProduct?.updatedAt ||
          latestProduct?.createdAt
        ) {

          const daysOld =

            (
              Date.now() -
              new Date(
                latestProduct.updatedAt ||
                latestProduct.createdAt
              )
            ) / (1000 * 60 * 60 * 24);

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

    const { store } = req.query;
    if (!store) {
      return res.status(400)
        .json({
          error:
            "Store is required"
        });
    }

    // =========================
    // STORES
    // =========================

    const cleanStore = store
      .replace(/^https?:\/\//, "")
      .replace(/\/$/, "")
      .trim()
      .toLowerCase();

    const stores =
      await Store.find({
        domain: new RegExp(
          `^${cleanStore}$`,
          "i"
        )
      }).lean();

    // =========================
    // FETCH PRODUCTS
    // =========================

    const promises =

      stores.map(async store => {

        try {

          const cleanDomain =
            store.domain.replace(
              /\/$/,
              ""
            );

          const response =
            await fetch(

              `https://${cleanDomain}/admin/api/2024-01/graphql.json`,

              {
                method: "POST",

                headers: {

                  "X-Shopify-Access-Token":
                    store.accessToken,

                  "Content-Type":
                    "application/json",

                },

                body: JSON.stringify({

                  query: `
                  {
                    products(
  first: 60,
  sortKey: UPDATED_AT,
  reverse: true,
  query: "status:ACTIVE"
) {

                      edges {

                        node {
  id
  title
  handle
  createdAt
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
          return (

            data?.data?.products?.edges?.map(item => {

              const node =
                item.node;

              return {

                id:
                  node.id,

                title:
                  node.title || "",

                handle:
                  node.handle || "",

                createdAt:
                  node.createdAt || null,
                publishedAt: node.publishedAt,
                status: node.status,
                timestamp:
                  new Date(
                    node.createdAt || 0
                  ).getTime(),

                image:
                  node.images
                    ?.edges?.[0]
                    ?.node?.url || "",

                price:
                  node.variants
                    ?.edges?.[0]
                    ?.node?.price || "0",

                store:
                  cleanDomain,

              };

            }) || []

          );

        } catch (err) {

          console.log(
            "TRENDING ERROR:",
            store.domain
          );

          return [];

        }

      });

    // =========================
    // RESULTS
    // =========================

    const results =
      await Promise.all(
        promises
      );

    // =========================
    // ANALYTICS DATA
    // =========================

    const analyticsData =

      await Analytics.aggregate([

        {
          $match: {

            store:
              new RegExp(
                `^${store}$`,
                "i"
              ),

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

    analyticsData.forEach(a => {

      analyticsMap[
        a._id
      ] = a;

    });

    // =========================
    // PRODUCTS
    // =========================

    let products = results
      .flat()
      .filter(p =>
        p.status === "ACTIVE" &&
        p.publishedAt
      );

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
            analytics.clicks * 3000;

          // SEARCH BOOST
          score +=
            analytics.searches * 1200;

          // LOW ENGAGEMENT PENALTY
          if (
            analytics.clicks < 2 &&
            analytics.searches < 2
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