const express = require("express");
const router = express.Router();
const fetch = require("node-fetch");
const Settings = require("../Models/settingsModel");
const Product = require("../Models/productModel");
const Store = require("../Models/store")
const Collection = require("../Models/collectionModel");
const verifyWebhook = require('../middleware/verifyShopifyWebhook')



// 🔄 SYNC PRODUCTS (Fetch version)
router.post("/sync-products", async (req, res) => {

  try {

    const { shop } = req.body;

    if (!shop) {

      return res.status(400).json({
        error: "Shop required"
      });
    }

    // =========================
    // 🔥 GET STORE TOKEN
    // =========================
    const store =
      await Store.findOne({
        domain: shop
      });

    if (!store) {

      return res.status(404).json({
        error: "Store not found"
      });
    }

    let hasNextPage = true;

    let cursor = null;

    let totalSynced = 0;

    // =========================
    // 🔥 LOOP ALL PRODUCTS
    // =========================
    while (hasNextPage) {

      const query = `
      query {

        products(
          first: 250
          after: ${cursor
          ? `"${cursor}"`
          : null
        }
        ) {

          pageInfo {
            hasNextPage
          }

          edges {

            cursor

            node {

              id
              title
              handle
              vendor
              productType
              tags
              status

              featuredImage {
                url
              }

              variants(first: 1) {
                edges {
                  node {
                    price
                    inventoryQuantity
                  }
                }
              }

              collections(first: 20) {
                edges {
                  node {
                    title
                  }
                }
              }
            }
          }
        }
      }
      `;

      // =========================
      // 🔥 SHOPIFY API
      // =========================
      const response = await fetch(
        `https://${shop}/admin/api/2024-01/graphql.json`,
        {
          method: "POST",

          headers: {
            "X-Shopify-Access-Token":
              store.accessToken,

            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({
            query
          })
        }
      );

      const data =
        await response.json();

      const products =
        data?.data?.products
          ?.edges || [];

      // =========================
      // 🔥 BULK OPERATIONS
      // =========================
      const operations =
        products.map(item => {

          const p = item.node;

          const collections =
            p.collections?.edges
              ?.map(c =>
                c.node.title
              ) || [];

          const price =
            p.variants?.edges?.[0]
              ?.node?.price || "0";

          const stock =
            p.variants?.edges?.[0]
              ?.node
              ?.inventoryQuantity || 0;

          return {

            updateOne: {

              filter: {
                store: shop,
                productId: p.id
              },

              update: {

                $set: {

                  store: shop,

                  productId: p.id,

                  title:
                    p.title || "",

                  handle:
                    p.handle || "",

                  vendor:
                    p.vendor || "",

                  productType:
                    p.productType || "",

                  tags:
                    p.tags || [],

                  collections,

                  image:
                    p.featuredImage
                      ?.url || "",

                  price,

                  stock,

                  status:
                    p.status || "",

                  searchableText: `
                    ${p.title}
                    ${p.vendor}
                    ${(p.tags || [])
                      .join(" ")}
                    ${collections
                      .join(" ")}
                  `
                }
              },

              upsert: true
            }
          };
        });

      // =========================
      // 🔥 SAVE BATCH
      // =========================
      if (operations.length > 0) {

        await Product.bulkWrite(
          operations
        );

        totalSynced +=
          operations.length;
      }

      // =========================
      // 🔥 PAGINATION
      // =========================
      hasNextPage =
        data?.data?.products
          ?.pageInfo
          ?.hasNextPage;

      cursor =
        products[
          products.length - 1
        ]?.cursor;

      console.log(
        "SYNCED:",
        totalSynced
      );
    }

    // =========================
    // ✅ DONE
    // =========================
    res.json({
      success: true,
      totalSynced
    });

  } catch (err) {

    console.log(
      "SYNC ERROR:",
      err
    );

    res.status(500).json({
      error: err.message
    });
  }
});

router.post(
  "/sync-collections",

  async (req, res) => {

    try {

      let { shop } =
        req.body;

      if (!shop) {

        return res.status(400)
          .json({
            error:
              "Shop required"
          });
      }

      shop = shop
        .replace(/^https?:\/\//, "")
        .replace(/\/$/, "")
        .trim()
        .toLowerCase();

      // =========================
      // 🔥 STORE
      // =========================
      const store =
        await Store.findOne({
          domain: shop
        });

      if (!store) {

        return res.status(404)
          .json({
            error:
              "Store not found"
          });
      }

      let allCollections = [];

      // =====================================
      // FETCH FUNCTION
      // =====================================
      const fetchCollections =
        async (type) => {

          let since_id = 0;
          let hasMore = true;

          while (hasMore) {

            const response =
              await fetch(

                `https://${shop}/admin/api/2025-01/${type}.json?limit=250&since_id=${since_id}`,

                {
                  headers: {
                    "X-Shopify-Access-Token":
                      store.accessToken,

                    "Content-Type":
                      "application/json"
                  }
                }
              );

            const data =
              await response.json();

            const key =
              type ===
                "custom_collections"

                ? "custom_collections"

                : "smart_collections";

            const collections =
              data[key] || [];

            console.log(
              `${type}:`,
              collections.length
            );

            if (
              collections.length === 0
            ) {

              hasMore = false;
              break;
            }

            allCollections.push(
              ...collections
            );

            since_id =
              collections[
                collections.length - 1
              ].id;
          }
        };

      // =====================================
      // CUSTOM COLLECTIONS
      // =====================================
      await fetchCollections(
        "custom_collections"
      );

      // =====================================
      // SMART COLLECTIONS
      // =====================================
      await fetchCollections(
        "smart_collections"
      );

      console.log(
        "TOTAL COLLECTIONS:",
        allCollections.length
      );

      // =====================================
      // FORMAT
      // =====================================
      const formatted =
        allCollections.map(c => ({

          store: shop,

          collectionId:
            String(c.id),

          title:
            c.title || "",

          handle:
            c.handle || "",

          image:
            c.image?.src || "",

          productsCount:
            0,

          searchableText: `

            ${c.title || ""}

            ${c.handle || ""}

          `
            .toLowerCase()
            .replace(/\s+/g, " ")
            .trim()

        }));

      // =====================================
      // DELETE OLD
      // =====================================
      await Collection.deleteMany({
        store: shop
      });

      // =====================================
      // INSERT NEW
      // =====================================
      if (formatted.length > 0) {

        await Collection.insertMany(
          formatted,
          { ordered: false }
        );
      }

      res.json({

        success: true,

        synced:
          formatted.length

      });

    } catch (err) {

      console.log(
        "COLLECTION SYNC ERROR:",
        err
      );

      res.status(500).json({
        error:
          err.message
      });
    }
  }
);

module.exports = router;