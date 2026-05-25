const mongoose =
  require("mongoose");

const analyticsSchema =
  new mongoose.Schema({

    // ======================
    // EVENT TYPE
    // ======================

    type: {
      type: String,
      enum: [
        "search",
        "click",
        "no_result"
      ],
      required: true,
    },

    // ======================
    // SEARCH QUERY
    // ======================

    query: {
      type: String,
      default: "",
      index: true,
    },

    normalizedQuery: {
      type: String,
      default: "",
      index: true,
    },

    // ======================
    // PRODUCT DATA
    // ======================

    productId: {
      type: String,
      default: null,
      index: true,
    },

    productTitle: {
      type: String,
      default: null,
    },

    productHandle: {
      type: String,
      default: null,
    },

    productImage: {
      type: String,
      default: null,
    },

    // ======================
    // VENDOR
    // ======================

    vendor: {
      type: String,
      default: null,
      index: true,
    },

    // ======================
    // STORE
    // ======================

    store: {
      type: String,
      required: true,
      index: true,
    },

    // ======================
    // METADATA
    // ======================

    source: {
      type: String,
      default: "search-app",
    },

    device: {
      type: String,
      default: null,
    },

    resultsCount: {
      type: Number,
      default: 0,
    },

    // ======================
    // TIMESTAMP
    // ======================

    createdAt: {
      type: Date,
      default: Date.now,
      index: true,
    },

  });


// ======================
// INDEXES 🔥
// ======================

analyticsSchema.index({
  store: 1,
  type: 1,
  createdAt: -1
});

analyticsSchema.index({
  vendor: 1,
  createdAt: -1
});

analyticsSchema.index({
  normalizedQuery: 1,
  createdAt: -1
});

analyticsSchema.index({
  productId: 1
});

analyticsSchema.index({
  resultsCount: 1
});

module.exports =
  mongoose.model(
    "Analytics",
    analyticsSchema
  );