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
    const originalQuery = q.toLowerCase();

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
    const synonymData = await Synonym.findOne({
      query: q,
      store: shop
    });

    if (synonymData && synonymData.synonyms.length > 0) {
      console.log("Original Query:", q);

      q = synonymData.synonyms[0];

      console.log("Synonym Applied:", q);
    }

    // =========================
    // 🔥 GET BOOSTS
    // =========================
    const boosts = await Boost.find({
      query: originalQuery,
      store: shop
    });

    const boostedIds = boosts.map(b => b.productId);

    console.log("Boosted IDs:", boostedIds);

    // =========================
    // 🔥 GET STORE
    // =========================
    const store = await Store.findOne({ domain: shop });

    if (!store) {
      return res.status(404).json({ error: "Store not found" });
    }

    // =========================
    // 🔥 SHOPIFY API CALL
    // =========================
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
          query {
            products(first: 10, query: "${q}") {
              edges {
                node {
                  id
                  title
                  handle
                  vendor
                  images(first: 1) {
                    edges {
                      node { url }
                    }
                  }
                  variants(first: 1) {
                    edges {
                      node { price }
                    }
                  }
                }
              }
            }

            collections(first: 5, query: "${q}") {
              edges {
                node {
                  title
                  handle
                }
              }
            }
          }
          `,
        }),
      }
    );

    const data = await response.json();

    // =========================
    // 🔥 FORMAT PRODUCTS
    // =========================
    let products =
      data?.data?.products?.edges?.map(item => ({
        id: item.node.id,
        title: item.node.title,
        handle: item.node.handle,
        vendor: item.node.vendor,
        image: item.node.images?.edges?.[0]?.node?.url || "",
        price: item.node.variants?.edges?.[0]?.node?.price || "0",
      })) || [];

    // =========================
    // 🔥 APPLY BOOST SORTING
    // =========================
    if (boostedIds.length > 0) {

      const boosted = [];
      const normal = [];

      for (let p of products) {
        if (boostedIds.includes(p.id)) {
          boosted.push(p);
        } else {
          normal.push(p);
        }
      }

      products = [...boosted, ...normal];
    }

    // =========================
    // 🔥 FORMAT COLLECTIONS
    // =========================
    const collections =
      data?.data?.collections?.edges?.map(c => ({
        title: c.node.title,
        handle: c.node.handle,
      })) || [];

    // =========================
    // 🔥 VENDORS
    // =========================
    const vendors = [
      ...new Set(products.map(p => p.vendor).filter(Boolean))
    ];

    // =========================
    // 🔥 RESPONSE
    // =========================
    res.json({
      products,
      collections,
      vendors
    });

  } catch (err) {
    console.log("SERVER ERROR:", err);
    res.status(500).json({ error: err.message });
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