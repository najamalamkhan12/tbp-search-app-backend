import mongoose from "mongoose";

const featuredBrandSchema =
  new mongoose.Schema({

    title: String,

    priority: {
      type: Number,
      default: 0
    },

    active: {
      type: Boolean,
      default: true
    },

    image: String,

    createdAt: {
      type: Date,
      default: Date.now
    }

  });

export default mongoose.model(
  "FeaturedBrand",
  featuredBrandSchema
);