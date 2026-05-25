const express = require("express");
const router = express.Router();
const fetch = require("node-fetch");
const Product = require("../Models/productModel");
const Store = require("../Models/store")
const Collection = require("../Models/collectionModel");

// 🔄 SYNC PRODUCTS (Fetch version)
router.post("/sync-products", async (req, res) => {

  try {

    let { shop } = req.body;

    if (!shop) {

      return res.status(400).json({
        error: "Shop required"
      });
    }

    // =========================
    // 🔥 CLEAN SHOP DOMAIN
    // =========================
    shop = shop
      .replace(/^https?:\/\//, "")
      .replace(/\/$/, "")
      .trim()
      .toLowerCase();

    // =========================
    // 🔥 GET STORE TOKEN
    // =========================
    const store = await Store.findOne({
      domain: shop
    }).lean();

    if (!store) {

      return res.status(404).json({
        error: "Store not found"
      });
    }

    let hasNextPage = true;

    let cursor = null;

    let totalSynced = 0;

    let allProductIds = new Set();
    let retryCount = 0;
    // =========================
    // 🔥 LOOP ALL PRODUCTS
    // =========================
    while (hasNextPage) {

      const query = `
query getProducts($cursor: String) {

  products(
    first: 250,
    query: "status:active",
    after: $cursor
  ) {

    pageInfo {
      hasNextPage
    }

    edges {

      cursor

      node {
        title
        handle
        description(truncateAt: 500)
        vendor
        productType
        tags
        status
        createdAt
        updatedAt
        publishedAt
        id

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

        collections(first: 10) {
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
        `https://${shop}/admin/api/2025-01/graphql.json`,
        {
          method: "POST",

          headers: {
            "X-Shopify-Access-Token":
              store.accessToken,

            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({
            query,
            variables: {
              cursor
            }
          })
        }
      );

      if (response.status === 429) {

        retryCount++;

        console.log(
          `SHOPIFY RATE LIMITED... RETRY ${retryCount}`
        );

        if (retryCount >= 5) {

          throw new Error(
            "Shopify rate limit exceeded"
          );

        }

        await new Promise(resolve =>
          setTimeout(
            resolve,
            2000 * retryCount
          )
        );

        continue;
      }

      // RESET RETRIES
      retryCount = 0;

      if (!response.ok) {

        throw new Error(
          `Shopify API Failed: ${response.status}`
        );

      }

      const data = await response.json();

      // =========================
      // 🔥 CHECK ERRORS
      // =========================
      if (data?.errors) {

        console.error(
          "SHOPIFY GRAPHQL ERROR:",
          JSON.stringify(
            data.errors || data,
            null,
            2
          )
        );

        throw new Error(
          data.errors?.[0]?.message ||
          "Shopify GraphQL Error"
        );
      }

      const products =
        data?.data?.products?.edges || [];

      // =========================
      // 🔥 BULK OPERATIONS
      // =========================
      const operations =
        products.map(item => {

          const p = item.node;

          allProductIds.add(
            String(p.id)
          );
          // COLLECTIONS
          const collections =
            Array.isArray(
              p.collections?.edges
            )
              ? p.collections.edges.map(
                c => c.node.title || ""
              )
              : [];

          // PRICE
          const price =
            Number(
              p.variants?.edges?.[0]
                ?.node?.price || 0
            );

          // STOCK
          const stock =
            p.variants?.edges?.[0]
              ?.node
              ?.inventoryQuantity || 0;

          // SEARCHABLE TEXT
          const searchableText = [

            String(p.title || ""),

            String(p.vendor || ""),

            String(p.productType || ""),

            Array.isArray(p.tags)
              ? p.tags.join(" ")
              : "",

            Array.isArray(collections)
              ? collections.join(" ")
              : ""

          ]
            .join(" ")
            .toLowerCase()
            .replace(/\s+/g, " ")
            .trim();

          return {

            updateOne: {

              filter: {
                store: shop,
                productId: String(p.id)
              },

              update: {

                $set: {

                  store: shop,

                  productId:
                    String(p.id),

                  title:
                    p.title || "",

                  handle:
                    p.handle || "",

                  description:
                    p.description || "",

                  vendor:
                    p.vendor || "",

                  productType:
                    p.productType || "",

                  tags:
                    Array.isArray(p.tags)
                      ? p.tags
                      : [],

                  image:
                    p.featuredImage?.url || "",

                  price: Number(price) || 0,

                  stock:
                    stock,

                  collections:
                    collections,

                  status:
                    (p.status || "active").toLowerCase(),

                  shopifyCreatedAt:
                    p.createdAt,

                  publishedAt:
                    p.publishedAt
                      ? new Date(p.publishedAt)
                      : new Date(p.createdAt),

                  shopifyUpdatedAt:
                    p.updatedAt,
                  searchableText
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
          operations,
          { ordered: false }
        );

        totalSynced +=
          operations.length;
      }

      // =========================
      // 🔥 PAGINATION
      // =========================
      hasNextPage =
        data?.data?.products
          ?.pageInfo?.hasNextPage;

      cursor =
        products[
          products.length - 1
        ]?.cursor || null;
    }

    // =========================
    // 🔥 DELETE REMOVED PRODUCTS
    // =========================

    if (
      allProductIds.size > 0 &&
      totalSynced > 0
    ) {

      await Product.deleteMany({
        store: shop,
        productId: {
          $nin: [...allProductIds]
        }
      });

    }

    // =========================
    // ✅ DONE
    // =========================
    res.json({

      success: true,

      totalSynced

    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: err.message
    });
  }
});

router.post("/sync-collections", async (req, res) => {

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
    const store = await Store.findOne({
      domain: shop
    }).lean();

    if (!store) {

      return res.status(404)
        .json({
          error:
            "Store not found"
        });
    }

    // =====================================
    // 🔥 FETCH FUNCTION
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
          if (!response.ok) {

            throw new Error(
              `Shopify Collections API Failed: ${response.status}`
            );

          }

          const data = await response.json();

          if (
            data.errors ||
            data.error
          ) {

            console.error(
              "SHOPIFY API ERROR:",
              JSON.stringify(
                data,
                null,
                2
              )
            );

            throw new Error("Shopify token expired");
          }

          const key =
            type ===
              "custom_collections"

              ? "custom_collections"

              : "smart_collections";

          const collections =
            data[key] || [];

          const filteredCollections =
            collections.filter(c => {

              return (
                c.title &&
                c.handle &&
                c.published_at
              );

            });

          const operations =
            filteredCollections.map(c => {

              collectionIds.add(
                String(c.id)
              );
              const searchableText = [

                c.title || "",

                c.handle || "",

                c.body_html || ""

              ]
                .join(" ")
                .toLowerCase()
                .replace(/\s+/g, " ")
                .trim();

              return {

                updateOne: {

                  filter: {
                    store: shop,
                    collectionId:
                      String(c.id)
                  },

                  update: {

                    $set: {

                      store: shop,

                      collectionId:
                        String(c.id),

                      title:
                        c.title || "",

                      handle:
                        c.handle || "",

                      description:
                        c.body_html || "",

                      image:
                        c.image?.src || "",

                      searchableText,

                      publishedAt:
                        c.published_at
                          ? new Date(
                            c.published_at
                          )
                          : null,

                      shopifyCreatedAt:
                        new Date(
                          c.published_at ||
                          c.created_at
                        ),

                      shopifyUpdatedAt:
                        c.updated_at
                          ? new Date(
                            c.updated_at
                          )
                          : new Date(
                            c.created_at
                          )

                    }

                  },

                  upsert: true

                }

              };

            });

          if (operations.length > 0) {

            await Collection.bulkWrite(
              operations,
              { ordered: false }
            );

          }

          if (
            collections.length === 0
          ) {

            hasMore = false;

            break;
          }

          since_id =
            collections[
              collections.length - 1
            ].id;
        }

      };

    let collectionIds =
      new Set();

    // =====================================
    // 🔥 CUSTOM COLLECTIONS
    // =====================================
    await fetchCollections(
      "custom_collections"
    );

    // =====================================
    // 🔥 SMART COLLECTIONS
    // =====================================
    await fetchCollections(
      "smart_collections"
    );

    const totalCollections =
      collectionIds.size;

    // =====================================
    // 🔥 DELETE REMOVED COLLECTIONS
    // =====================================

    if (
      totalCollections > 0
    ) {

      await Collection.deleteMany({

        store: shop,

        collectionId: {
          $nin: [...collectionIds]
        }

      });

    }

    // =====================================
    // ✅ DONE
    // =====================================
    res.json({

      success: true,

      synced:
        totalCollections

    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: err.message
    });
  }
}
);

module.exports = router;