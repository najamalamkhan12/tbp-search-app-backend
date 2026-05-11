const mongoose = require("mongoose");

const productSchema =
  new mongoose.Schema({

    // =========================
    // 🔥 STORE
    // =========================
    store: {
      type: String,
      required: true,
      index: true
    },

    // =========================
    // 🔥 PRODUCT ID
    // =========================
    productId: {
      type: String,
      required: true
    },

    // =========================
    // 🔥 TITLE
    // =========================
    title: {
      type: String,
      default: "",
      index: true
    },

    // =========================
    // 🔥 HANDLE
    // =========================
    handle: {
      type: String,
      default: ""
    },

    // =========================
    // 🔥 DESCRIPTION
    // =========================
    description: {
      type: String,
      default: ""
    },

    // =========================
    // 🔥 VENDOR
    // =========================
    vendor: {
      type: String,
      default: "",
      index: true
    },

    // =========================
    // 🔥 PRODUCT TYPE
    // =========================
    productType: {
      type: String,
      default: ""
    },

    // =========================
    // 🔥 TAGS
    // =========================
    tags: {
      type: [String],
      default: []
    },

    // =========================
    // 🔥 COLLECTIONS
    // =========================
    collections: {
      type: [String],
      default: []
    },

    // =========================
    // 🔥 IMAGE
    // =========================
    image: {
      type: String,
      default: ""
    },

    // =========================
    // 🔥 PRICE
    // =========================
    price: {
      type: String,
      default: "0"
    },

    // =========================
    // 🔥 STOCK
    // =========================
    stock: {
      type: Number,
      default: 0
    },

    // =========================
    // 🔥 STATUS
    // =========================
    status: {
      type: String,
      default: "ACTIVE",
      index: true
    },

    // =========================
    // 🔥 SEARCHABLE TEXT
    // =========================
    searchableText: {
      type: String,
      default: ""
    },

  }, {
    timestamps: true
  });


// ========================================
// 🔥 AUTO GENERATE SEARCHABLE TEXT
// ========================================
productSchema.pre("save", function (next) {

  this.searchableText = `
    ${this.title}
    ${this.vendor}
    ${this.productType}
    ${this.tags.join(" ")}
    ${this.collections.join(" ")}
  `.toLowerCase();

  next();
});


// ========================================
// 🔥 PREVENT DUPLICATES
// ========================================
productSchema.index({
  store: 1,
  productId: 1
}, {
  unique: true
});


// ========================================
// 🔥 TEXT SEARCH INDEX
// ========================================
productSchema.index({
  searchableText: "text"
});


// ========================================
// 🔥 FAST FILTERS
// ========================================
productSchema.index({
  store: 1,
  vendor: 1
});

productSchema.index({
  store: 1,
  status: 1
});


// ========================================
// 🔥 EXPORT
// ========================================
module.exports =
  mongoose.model(
    "Product",
    productSchema
  );