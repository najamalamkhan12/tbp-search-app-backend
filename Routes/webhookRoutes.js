const express = require("express");
const router = express.Router();

router.use((req, res, next) => {

  console.log(
    "🔥 WEBHOOK ROUTE HIT:",
    req.path
  );

  next();
});

const Product =
  require("../Models/productModel");

const Store =
  require("../Models/store");

const verifyShopifyWebhook =
  require("../middleware/verifyShopifyWebhook");

// =====================================
// CREATE PRODUCT
// =====================================
router.post(
  "/products/create",

  verifyShopifyWebhook,

  async (req, res) => {

    try {

      const product =
        JSON.parse(
          req.body.toString()
        );

      const shop =
        req.headers[
          "x-shopify-shop-domain"
        ];

      const store =
        await Store.findOne({
          domain: shop
        });

      if (!store) {

        console.log(
          "❌ Store not found:",
          shop
        );

        return res
          .status(404)
          .send("Store not found");
      }

      const searchableText = `

${product.title || ""}

${product.vendor || ""}

${product.product_type || ""}

${product.tags || ""}

      `.toLowerCase();

      await Product.findOneAndUpdate(

        {
          productId:
            String(product.id),

          store: shop
        },

        {
          store: shop,

          productId:
            String(product.id),

          title:
            product.title || "",

          handle:
            product.handle || "",

          vendor:
            product.vendor || "",

          productType:
            product.product_type || "",

          tags:
            product.tags
              ? product.tags
                  .split(",")
                  .map(t => t.trim())
              : [],

          image:
            product.image?.src || "",

          price:
            product.variants?.[0]
              ?.price || "0",

          status:
            (
              product.status ||
              "active"
            ).toUpperCase(),

          searchableText,

          updatedAt:
            new Date()
        },

        {
          upsert: true,
          new: true
        }
      );

      console.log(
        "✅ PRODUCT CREATED:",
        product.title
      );

      res.status(200).send("OK");

    } catch (err) {

      console.log(
        "CREATE WEBHOOK ERROR:",
        err
      );

      res.status(500).send("Error");
    }
  }
);

// =====================================
// UPDATE PRODUCT
// =====================================
router.post(
  "/products/update",

  verifyShopifyWebhook,

  async (req, res) => {

    try {

      const product =
        JSON.parse(
          req.body.toString()
        );

      const shop =
        req.headers[
          "x-shopify-shop-domain"
        ];

      const store =
        await Store.findOne({
          domain: shop
        });

      if (!store) {

        console.log(
          "❌ Store not found:",
          shop
        );

        return res
          .status(404)
          .send("Store not found");
      }

      const searchableText = `

${product.title || ""}

${product.vendor || ""}

${product.product_type || ""}

${product.tags || ""}

      `.toLowerCase();

      await Product.findOneAndUpdate(

        {
          productId:
            String(product.id),

          store: shop
        },

        {
          store: shop,

          productId:
            String(product.id),

          title:
            product.title || "",

          handle:
            product.handle || "",

          vendor:
            product.vendor || "",

          productType:
            product.product_type || "",

          tags:
            product.tags
              ? product.tags
                  .split(",")
                  .map(t => t.trim())
              : [],

          image:
            product.image?.src || "",

          price:
            product.variants?.[0]
              ?.price || "0",

          status:
            (
              product.status ||
              "active"
            ).toUpperCase(),

          searchableText,

          updatedAt:
            new Date()
        },

        {
          upsert: true,
          new: true
        }
      );

      console.log(
        "♻️ PRODUCT UPDATED:",
        product.title
      );

      res.status(200).send("OK");

    } catch (err) {

      console.log(
        "UPDATE WEBHOOK ERROR:",
        err
      );

      res.status(500).send("Error");
    }
  }
);

// =====================================
// DELETE PRODUCT
// =====================================
router.post(
  "/products/delete",

  verifyShopifyWebhook,

  async (req, res) => {

    try {

      const product =
        JSON.parse(
          req.body.toString()
        );

      const shop =
        req.headers[
          "x-shopify-shop-domain"
        ];

      await Product.findOneAndDelete({

        productId:
          String(product.id),

        store: shop
      });

      console.log(
        "🗑️ PRODUCT DELETED:",
        product.id
      );

      res.status(200).send("OK");

    } catch (err) {

      console.log(
        "DELETE WEBHOOK ERROR:",
        err
      );

      res.status(500).send("Error");
    }
  }
);

module.exports = router;