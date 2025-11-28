import mongoose from "mongoose";
import config from "./config.json" assert { type: "json" };

export async function connectDB() {
  await mongoose.connect(config.mongo, {
    useNewUrlParser: true,
    useUnifiedTopology: true
  });
  console.log("📦 MongoDB bağlandı!");
}
