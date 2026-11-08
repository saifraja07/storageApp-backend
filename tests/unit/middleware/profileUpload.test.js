import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { profileUpload } from "../../../middleWares/profileUploadMiddleware.js";

const app = express();
app.post("/upload", profileUpload, (req, res) =>
  res.json({ hasFile: Boolean(req.file), size: req.file?.size ?? 0 }),
);

describe("profileUpload middleware", () => {
  it("accepts a small image in the 'picture' field and keeps it in memory", async () => {
    const res = await request(app)
      .post("/upload")
      .attach("picture", Buffer.alloc(1024), "avatar.png")
      .expect(200);
    expect(res.body).toEqual({ hasFile: true, size: 1024 });
  });

  it("passes through when no file is sent", async () => {
    const res = await request(app).post("/upload").field("name", "x").expect(200);
    expect(res.body.hasFile).toBe(false);
  });

  it("rejects files larger than 5 MB with a clear message", async () => {
    const res = await request(app)
      .post("/upload")
      .attach("picture", Buffer.alloc(5 * 1024 * 1024 + 1), "big.png")
      .expect(400);
    expect(res.body).toEqual({ error: "Profile image must be 5 MB or smaller." });
  });

  it("rejects files sent under the wrong field name", async () => {
    const res = await request(app)
      .post("/upload")
      .attach("avatar", Buffer.alloc(10), "x.png")
      .expect(400);
    expect(res.body).toEqual({ error: "Invalid or unsupported image." });
  });

  it("rejects more than one file", async () => {
    const res = await request(app)
      .post("/upload")
      .attach("picture", Buffer.alloc(10), "a.png")
      .attach("picture", Buffer.alloc(10), "b.png")
      .expect(400);
    expect(res.body.error).toBe("Invalid or unsupported image.");
  });
});
