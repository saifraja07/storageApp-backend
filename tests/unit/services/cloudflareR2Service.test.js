import { describe, it, expect, vi, beforeEach } from "vitest";
import * as r2 from "../../../services/cloudflareR2Service.js";

const USER = "507f1f77bcf86cd799439011";
const OTHER = "507f1f77bcf86cd799439012";

describe("profile picture URL helpers", () => {
  it("joins the CDN base and key without double slashes", () => {
    expect(r2.getProfilePictureURL("profile-pictures/u/a.webp")).toBe(
      "https://cdn.example.com/profile-pictures/u/a.webp",
    );
    expect(r2.getProfilePictureURL("/profile-pictures/u/a.webp")).toBe(
      "https://cdn.example.com/profile-pictures/u/a.webp",
    );
  });

  it("extracts the key only from URLs on our CDN origin", () => {
    expect(r2.getProfilePictureKeyFromURL("https://cdn.example.com/profile-pictures/u/a.webp")).toBe(
      "profile-pictures/u/a.webp",
    );
    expect(r2.getProfilePictureKeyFromURL("https://evil.example.org/profile-pictures/u/a.webp")).toBeNull();
    expect(r2.getProfilePictureKeyFromURL("http://cdn.example.com/profile-pictures/u/a.webp")).toBeNull();
  });

  it("returns null for invalid input", () => {
    expect(r2.getProfilePictureKeyFromURL(undefined)).toBeNull();
    expect(r2.getProfilePictureKeyFromURL(42)).toBeNull();
    expect(r2.getProfilePictureKeyFromURL("not a url")).toBeNull();
    expect(r2.getProfilePictureKeyFromURL("https://cdn.example.com/")).toBeNull();
  });
});

describe("isOwnedProfilePictureURL", () => {
  const own = `https://cdn.example.com/profile-pictures/${USER}/pic.webp`;

  it("is true for the user's own picture on the CDN", () => {
    expect(r2.isOwnedProfilePictureURL(own, USER)).toBe(true);
  });

  it("is false for another user's picture", () => {
    expect(r2.isOwnedProfilePictureURL(own, OTHER)).toBe(false);
  });

  it("is false for default / Google avatars and foreign hosts", () => {
    expect(r2.isOwnedProfilePictureURL("https://lh3.googleusercontent.com/a/x", USER)).toBe(false);
    expect(r2.isOwnedProfilePictureURL(`https://evil.example.org/profile-pictures/${USER}/p.webp`, USER)).toBe(false);
    expect(r2.isOwnedProfilePictureURL(undefined, USER)).toBe(false);
  });

  it("cannot be tricked into deleting another user's file via path traversal", () => {
    const traversal = `https://cdn.example.com/profile-pictures/${USER}/../${OTHER}/pic.webp`;
    expect(r2.isOwnedProfilePictureURL(traversal, USER)).toBe(false);
  });
});

describe("getStorage", () => {
  it("refuses to pick a bucket without the owner's user id", () => {
    expect(() => r2.getStorage()).toThrow(/requires the file owner's userId/);
    expect(() => r2.getStorage(null)).toThrow();
    expect(() => r2.getStorage("")).toThrow();
  });

  it("uses the production bucket by default", () => {
    const { client, bucket } = r2.getStorage(USER);
    expect(bucket).toBe("test-bucket");
    expect(client).toBe(r2.r2Client);
  });

  describe("personal storage routing", () => {
    beforeEach(() => {
      vi.resetModules();
      vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    it("fails closed (never falls back to production) when personal R2 is not configured", async () => {
      vi.stubEnv("PERSONAL_STORAGE_USER_IDS", USER);
      const fresh = await import("../../../services/cloudflareR2Service.js");
      expect(() => fresh.getStorage(USER)).toThrow("Personal R2 storage is not fully configured");
      expect(fresh.getStorage(OTHER).bucket).toBe("test-bucket");
    });

    it("routes listed users to the personal bucket when it is configured", async () => {
      vi.stubEnv("PERSONAL_STORAGE_USER_IDS", USER);
      vi.stubEnv("PERSONAL_R2_BUCKET", "personal-bucket");
      vi.stubEnv("PERSONAL_R2_ENDPOINT", "https://personal.r2.cloudflarestorage.com");
      vi.stubEnv("PERSONAL_R2_ACCESS_KEY_ID", "pk");
      vi.stubEnv("PERSONAL_R2_SECRET_ACCESS_KEY", "ps");
      const fresh = await import("../../../services/cloudflareR2Service.js");
      expect(fresh.getStorage(USER).bucket).toBe("personal-bucket");
      expect(fresh.getStorage(OTHER).bucket).toBe("test-bucket");
    });
  });
});

describe("signed URLs (generated locally, no network)", () => {
  it("creates a short-lived signed upload URL for the user's bucket", async () => {
    const url = new URL(
      await r2.createUploadSignedUrl({ key: "abc.pdf", contentType: "application/pdf", userId: USER }),
    );
    expect(url.host).toContain("test-bucket");
    expect(url.pathname).toContain("abc.pdf");
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
  });

  it("creates a signed download URL that forces attachment when asked", async () => {
    const url = new URL(
      await r2.createGetSignedUrl({ key: "abc.pdf", download: true, filename: "My Report.pdf", userId: USER }),
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
    const disposition = url.searchParams.get("response-content-disposition");
    expect(disposition).toMatch(/^attachment;/);
    expect(disposition).toContain("My%20Report.pdf");
  });

  it("serves inline by default and neutralises quotes/newlines in filenames", async () => {
    const url = new URL(
      await r2.createGetSignedUrl({ key: "k.txt", filename: 'a"b\r\nc.txt', userId: USER }),
    );
    const disposition = url.searchParams.get("response-content-disposition");
    expect(disposition).toMatch(/^inline;/);
    expect(disposition).not.toMatch(/[\r\n]/);
    expect(disposition).toContain('filename="a_b  c.txt"');
  });

  it("requires a userId", async () => {
    await expect(r2.createUploadSignedUrl({ key: "k", contentType: "x" })).rejects.toThrow();
  });
});

describe("deleteR2Files", () => {
  let send;
  beforeEach(() => {
    send = vi.spyOn(r2.r2Client, "send").mockResolvedValue({});
  });

  const keys = (n) => Array.from({ length: n }, (_, i) => ({ Key: `k${i}` }));

  it("sends one request for up to 1000 keys", async () => {
    await r2.deleteR2Files(keys(1000), USER);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("batches larger deletions in groups of 1000", async () => {
    await r2.deleteR2Files(keys(2500), USER);
    expect(send).toHaveBeenCalledTimes(3);
    const sizes = send.mock.calls.map(([cmd]) => cmd.input.Delete.Objects.length);
    expect(sizes).toEqual([1000, 1000, 500]);
  });

  it("throws when R2 reports per-key failures so callers don't drop DB records", async () => {
    send.mockResolvedValue({ Errors: [{ Code: "AccessDenied" }] });
    await expect(r2.deleteR2Files(keys(2), USER)).rejects.toThrow(/AccessDenied/);
  });

  it("does nothing for an empty list", async () => {
    await r2.deleteR2Files([], USER);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("single-object operations", () => {
  it("deleteR2File targets the owner's bucket and key", async () => {
    const send = vi.spyOn(r2.r2Client, "send").mockResolvedValue({});
    await r2.deleteR2File({ key: "x.png", userId: USER });
    expect(send.mock.calls[0][0].input).toEqual({ Bucket: "test-bucket", Key: "x.png" });
  });

  it("profile pictures always use the dedicated public profile bucket", async () => {
    const send = vi.spyOn(r2.r2Client, "send").mockResolvedValue({});
    await r2.uploadProfilePicture({ key: "profile-pictures/u/a.webp", body: Buffer.from("x") });
    await r2.deleteProfilePicture({ key: "profile-pictures/u/a.webp" });
    expect(send.mock.calls[0][0].input.Bucket).toBe("test-profile-bucket");
    expect(send.mock.calls[0][0].input.ContentType).toBe("image/webp");
    expect(send.mock.calls[1][0].input.Bucket).toBe("test-profile-bucket");
  });
});
