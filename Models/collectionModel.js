const mongoose = require("mongoose");

const collectionSchema =
    new mongoose.Schema({

        store: {
            type: String,
            required: true,
            index: true
        },

        collectionId: {
            type: String,
            required: true
        },

        title: {
            type: String,
            default: "",
            index: true
        },

        handle: {
            type: String,
            default: "",
            index: true
        },

        image: {
            type: String,
            default: ""
        },

        description: {
            type: String,
            default: ""
        },

        rules: {
            type: Array,
            default: []
        },

        collectionType: {
            type: String,
            default: "",
            index: true
        },

        productsCount: {
            type: Number,
            default: 0,
            index: true
        },
        vendor: {
            type: String,
            default: "",
            index: true
        },
        shopifyCreatedAt: {
            type: Date,
            index: true
        },

        shopifyPublishedAt: {
            type: Date,
            index: true
        },

        firstPublishedAt: {
            type: Date,
            index: true
        },

        searchableText: {
            type: String,
            default: ""
        }

    }, {
        timestamps: true
    });

// =====================================
// UNIQUE COLLECTION
// =====================================
collectionSchema.index({
    store: 1,
    collectionId: 1
}, {
    unique: true
});

// =====================================
// TEXT SEARCH
// =====================================
collectionSchema.index(
    {
        title: "text",
        vendor: "text",
        searchableText: "text"
    },
    {
        weights: {
            title: 10,
            vendor: 6,
            searchableText: 2
        }
    }
);

// =====================================
// FAST NEWEST COLLECTIONS
// =====================================

collectionSchema.index({
    store: 1,
    firstPublishedAt: -1
});

collectionSchema.index({
    store: 1,
    shopifyPublishedAt: -1
});

collectionSchema.index({
    store: 1,
    updatedAt: -1
});

// =====================================
// FAST TITLE SEARCH
// =====================================
collectionSchema.index({
    store: 1,
    title: 1
});

// =====================================
// FAST HANDLE SEARCH
// =====================================
collectionSchema.index({
    store: 1,
    handle: 1
});

// =====================================
// TRENDING COLLECTIONS
// =====================================
collectionSchema.index({
    store: 1,
    productsCount: -1
});

// =====================================
// AUTO SEARCHABLE TEXT
// =====================================

collectionSchema.pre("save", function (next) {

    this.searchableText = `
      ${this.title}
      ${this.handle}
      ${this.vendor}
      ${this.description}
    `.toLowerCase();

    next();

});

module.exports = mongoose.model("Collection", collectionSchema);
