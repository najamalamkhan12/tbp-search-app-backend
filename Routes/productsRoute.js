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
    let previousCursor = null;
    // 🔥 LOOP ALL PRODUCTS
    // =========================
    while (hasNextPage) {
      const query = `
query getProducts($cursor: String) {

  products(
    first: 250,
    query:"status:active published_status:published",
    after: $cursor
  ) {

    pageInfo {
  hasNextPage
  endCursor
}

    edges {

      cursor

      node {
  id
  title
  handle
  descriptionHtml
  vendor
  productType
  status
  tags
  createdAt
  updatedAt
  publishedAt
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

        collections(first: 250) {
  edges {
    node {
      id
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
      const response =
        await fetch(
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

      if (
        !data?.data?.products
      ) {

        throw new Error(
          "Invalid Shopify products response"
        );
      }

      const products =
        data?.data?.products?.edges || [];

      if (
        products.length === 0
      ) {
        break;
      }

      // =========================
      // 🔥 BULK OPERATIONS
      // =========================
      const operations =
        products.map(item => {
          if (!item?.node) {
            return null;
          }
          const p = item.node;
          if (
            !p.publishedAt
          ) {
            return null;
          }
          if (p.id) {
            allProductIds.add(
              String(p.id)
            );
          }
          // COLLECTIONS
          const collections =
            Array.isArray(
              p.collections?.edges
            )
              ? p.collections.edges
                .filter(c => c?.node)
                .map(
                  c => ({
                    id:
                      String(c.node.id),

                    title:
                      c.node.title || ""
                  })
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
            Math.max(
              0,
              Number(
                p.variants?.edges?.[0]
                  ?.node
                  ?.inventoryQuantity
              ) || 0
            );
          // SEARCHABLE TEXT
          const searchableText = [

            String(p.title || ""),

            String(p.vendor || ""),

            String(p.productType || ""),

            Array.isArray(p.tags)
              ? p.tags.join(" ")
              : "",

            Array.isArray(collections)
              ? collections
                .map(c => c.title)
                .join(" ")
              : ""

          ]
            .join(" ")
            .toLowerCase()
            .replace(/\s+/g, " ")
            .trim();

          return {

            updateOne: {

              filter: {
                store:
                  shop
                    .trim()
                    .toLowerCase(),
                productId: String(p.id)
              },

              update: {

                $set: {
                  store:
                    shop
                      .trim()
                      .toLowerCase(),

                  productId:
                    String(p.id),

                  title:
                    p.title || "",

                  handle:
                    p.handle || "",

                  description:
                    String(
                      p.descriptionHtml || ""
                    )
                      .replace(/<[^>]*>/g, "")
                      .slice(0, 2000),
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

                  price: price || 0,

                  stock:
                    stock,

                  collections:
                    (collections || []).map(
                      c => String(c.id)
                    ),

                  status:
                    (p.status || "active").toLowerCase(),

                  shopifyCreatedAt:
                    p.createdAt
                      ? new Date(p.createdAt)
                      : null,

                  publishedAt:
                    p.publishedAt
                      ? new Date(p.publishedAt)
                      : (
                        p.createdAt
                          ? new Date(p.createdAt)
                          : null
                      ),

                  shopifyUpdatedAt:
                    p.updatedAt
                      ? new Date(p.updatedAt)
                      : null,
                  searchableText
                }
              },

              upsert: true
            }
          };
        }).filter(Boolean);

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
        Boolean(
          data?.data?.products
            ?.pageInfo?.hasNextPage
        );

      const nextCursor =
        data?.data?.products
          ?.pageInfo?.endCursor || null;
      if (!nextCursor) {
        break;
      }
      if (
        nextCursor === previousCursor
      ) {
        console.log(
          "DUPLICATE CURSOR STOPPED"
        );
        break;
      }
      previousCursor =
        nextCursor;

      cursor =
        nextCursor;
    }

    // =========================
    // 🔥 DELETE REMOVED PRODUCTS
    // =========================

    if (
      hasNextPage === false &&
      allProductIds.size > 5000 &&
      totalSynced > 5000
    ) {

      await Product.deleteMany({
        store: shop
          .trim()
          .toLowerCase(),
        productId: {
          $nin: Array.from(allProductIds)
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

// ==========================================
// 🔥 SYNC COLLECTIONS
// ==========================================
router.post("/sync-collections", async (req, res) => {
  try {
    const { shop } =
      req.body;
    if (!shop) {
      return res.status(400).json({
        error:
          "Shop is required"
      });
    }
    const normalizedShop =
      shop
        ?.trim()
        ?.toLowerCase();

    // ======================================
    // 🔥 SHOPIFY SESSION
    // ======================================
    const session =
      await Store.findOne({
        domain: normalizedShop
      });
    if (!session) {
      return res.status(404).json({
        error:
          "Store session not found"
      });
    }

    // ======================================
    // 🔥 STORE ALL IDS
    // ======================================
    let collectionIds =
      new Set();

    const rawCollections =
      await Product.find(
        {
          store:
            normalizedShop,
          status: "active",
          publishedAt: {
            $ne: null
          }
        },
        {
          collections: 1
        }
      ).lean();

    const activeCollections =
      new Set(
        rawCollections
          .flatMap(
            p =>
              p.collections || []
          )
          .map(id =>
            String(id))
      );

    // ======================================
    // 🔥 FETCH FUNCTION
    // ======================================
    const fetchCollections =
      async (type) => {

        let retryCount = 0;
        let hasMore = true;

        let nextPageUrl =
          `https://${normalizedShop}/admin/api/2025-01/${type}.json?limit=250`;

        while (hasMore) {

          const response =
            await fetch(
              nextPageUrl,

              {
                headers: {
                  "X-Shopify-Access-Token":
                    session.accessToken,
                  "Content-Type":
                    "application/json"
                }
              }
            );
          // ==============================
          // 🔥 RATE LIMIT
          // ==============================

          if (response.status === 429) {

            retryCount++;

            console.log(
              `COLLECTION RATE LIMITED... RETRY ${retryCount}`
            );

            if (retryCount >= 5) {

              throw new Error(
                "Collections rate limit exceeded"
              );

            }

            await new Promise(
              resolve =>
                setTimeout(
                  resolve,
                  2000 * retryCount
                )
            );

            continue;

          }

          retryCount = 0;

          if (!response.ok) {

            const errorText =
              await response.text();

            console.log(
              "COLLECTION API ERROR:",
              errorText
            );

            throw new Error(
              `Collections API Failed: ${response.status}`
            );

          }

          const linkHeader =
            response.headers.get("link");

          if (
            linkHeader &&
            linkHeader.includes('rel="next"')
          ) {

            const nextLink =
              linkHeader
                ?.split(",")
                ?.find(link =>
                  link.includes('rel="next"')
                );

            const match =
              nextLink?.match(
                /<([^>]+)>/
              );

            nextPageUrl =
              match?.[1] || null;

            hasMore =
              !!nextPageUrl;

          } else {

            hasMore = false;

          }

          const data =
            await response.json();

          const collections =
            Array.isArray(data[type])
              ? data[type]
              : [];

          // ==============================
          // 🔥 STOP PAGINATION
          // ==============================

          if (collections.length === 0) {

            break;

          }

          // ==============================
          // 🔥 PREPARE BULK OPS
          // ==============================

          const bulkOps =
            collections
              .map(c => {
                // ONLY ACTIVE PRODUCTS
                if (
                  !activeCollections.has(
                    String(c.id)
                  )
                ) {
                  return null;
                }
                collectionIds.add(
                  String(c.id)
                );
                return {
                  updateOne: {
                    filter: {
                      store:
                        normalizedShop,
                      collectionId:
                        String(c.id)
                    },

                    update: {

                      $set: {

                        store:
                          normalizedShop,

                        collectionId:
                          String(c.id),

                        title:
                          c.title || "",

                        handle:
                          c.handle || "",

                        description:
                          String(
                            c.body_html || ""
                          )
                            .replace(/<[^>]*>/g, "")
                            .slice(0, 2000),

                        image:
                          c.image?.src || "",

                        rules:
                          c.rules || [],

                        type,

                        publishedAt:
                          c.published_at
                            ? new Date(
                              c.published_at
                            )
                            : null

                      }

                    },

                    upsert: true

                  }

                };

              }).filter(Boolean);

          // ==============================
          // 🔥 BULK WRITE
          // ==============================

          if (bulkOps.length > 0) {

            await Collection.bulkWrite(
              bulkOps,
              {
                ordered: false
              }
            );

          }

          console.log(
            `${type} synced:`,
            bulkOps.length
          );

          // ==============================
          // 🔥 NEXT PAGE
          // ==============================

        }

      };

    // ======================================
    // 🔥 FETCH BOTH TYPES
    // ======================================

    await fetchCollections(
      "custom_collections"
    );
    await fetchCollections(
      "smart_collections"
    );

    // ======================================
    // 🔥 CLEANUP OLD COLLECTIONS
    // ======================================
    const totalCollections =
      collectionIds.size;
    if (
      totalCollections > 200
    ) {
      await Collection.deleteMany({
        store:
          normalizedShop,
        collectionId: {
          $nin:
            Array.from(
              collectionIds
            )
        }
      });
    }

    // ======================================
    // 🔥 RESPONSE
    // ======================================
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