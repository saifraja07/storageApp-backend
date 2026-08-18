import serverless from "serverless-http";
import { connectDB } from "./config/db.js";
import app from "./server.js";


await connectDB();


export const handler = serverless(app);