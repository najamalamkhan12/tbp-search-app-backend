const crypto = require("crypto");

const verifyShopifyWebhook = (
  req,
  res,
  next
) => {

  try {

    const hmac =
      req.headers[
      "x-shopify-hmac-sha256"
      ];

    console.log(
      "IS BUFFER:",
      Buffer.isBuffer(req.body)
    );

    const hash = crypto
      .createHmac(
        "sha256",
        process.env.SHOPIFY_WEBHOOK_SECRET
      )
      .update(req.body)
      .digest("base64");

    if (hash !== hmac) {

      console.log(
        "❌ HMAC FAILED"
      );

      return res
        .status(401)
        .send("Webhook verification failed");
    }

    console.log(
      "✅ HMAC VERIFIED"
    );

    next();

  } catch (err) {

    console.log(
      "WEBHOOK VERIFY ERROR:",
      err
    );

    res.status(500).send("Error");
  }
};

module.exports = verifyShopifyWebhook;