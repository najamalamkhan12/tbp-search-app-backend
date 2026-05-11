const express = require("express");
const router = express.Router();
const fetch = require("node-fetch");
const Store = require('../Models/store')
const Analytics = require("../Models/analyticsModel");
const Synonym = require("../Models/synonymModel");
const Boost = require("../Models/boostModel");

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

router.get("/search", async (req, res) => {

  try {

    let { q, shop } = req.query;

    shop = shop
      .replace("https://", "")
      .replace("http://", "")
      .replace("/", "")
      .trim()
      .toLowerCase();

    const originalQuery =
      (q || "").toLowerCase().trim();

    if (!q || !shop) {

      return res.json({
        products: [],
        collections: [],
        vendors: []
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

    let finalQuery = originalQuery;

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
      boosts.map(b => String(b.productId));

    console.log(
      "Boosted IDs:",
      boostedIds
    );

    // =========================
    // 🔥 SEARCH PRODUCTS FROM DB
    // =========================
    let products =
      await Product.find({

        store: shop,

        status: "ACTIVE",

        $or: [

          {
            title: {
              $regex: finalQuery,
              $options: "i"
            }
          },

          {
            vendor: {
              $regex: finalQuery,
              $options: "i"
            }
          },

          {
            productType: {
              $regex: finalQuery,
              $options: "i"
            }
          },

          {
            tags: {
              $elemMatch: {
                $regex: finalQuery,
                $options: "i"
              }
            }
          },

          {
            collections: {
              $elemMatch: {
                $regex: finalQuery,
                $options: "i"
              }
            }
          }

        ]

      })
        .limit(20)
        .lean();

    // =========================
    // 🔥 FORMAT PRODUCTS
    // =========================
    products = products.map(p => ({

      id: String(p.productId),

      title: p.title,

      handle: p.handle,

      vendor: p.vendor,

      image: p.image || "",

      price: p.price || "0"

    }));

    // =========================
    // 🔥 APPLY BOOST SORTING
    // =========================
    if (boostedIds.length > 0) {

      const boosted = [];
      const normal = [];

      for (let p of products) {

        if (
          boostedIds.includes(
            String(p.id)
          )
        ) {

          boosted.push(p);

        } else {

          normal.push(p);
        }
      }

      products = [
        ...boosted,
        ...normal
      ];
    }

    // =========================
    // 🔥 VENDORS
    // =========================
    const vendors = [

      ...new Set(

        products
          .map(p => p.vendor)
          .filter(Boolean)

      )

    ];

    // =========================
    // 🔥 COLLECTIONS
    // =========================
    const collections = [

      ...new Set(

        (
          await Product.find({

            store: shop,

            collections: {
              $exists: true
            }

          }).lean()
        )

          .flatMap(
            p => p.collections || []
          )

          .filter(c => {

            const lower =
              c.toLowerCase();

            return (

              lower.includes(finalQuery) ||

              vendors.some(v =>
                lower.includes(
                  v.toLowerCase()
                )
              )

            );

          })

      )

    ].slice(0, 5)
      .map(c => ({

        title: c,

        handle: c
          .toLowerCase()
          .replace(/\s+/g, "-")

      }));

    // =========================
    // 🔥 RESPONSE
    // =========================
    res.json({

      products,

      collections,

      vendors

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