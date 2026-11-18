import mongoose from "mongoose";

export async function connectDB() {
  try {
    await mongoose.connect(process.env.DB_URL);
    console.log("Database connected.");
  } catch (err) {
    console.log("Could Not Connect to the Database");
    console.log("Error: ", err.message);
    process.exit(1);
  }
}

// SIGINT is what PM2 sends; SIGTERM is what systemd, Docker and Lambda send.
const shutdown = async () => {
  await mongoose.disconnect();
  console.log("Client Disconnected!");
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
