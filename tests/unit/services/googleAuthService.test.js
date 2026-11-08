import { describe, it, expect, vi } from "vitest";
import { getUserFromAuthCode } from "../../../services/googleAuthService.js";

const { getToken, setCredentials, verifyIdToken } = vi.hoisted(() => ({
  getToken: vi.fn(),
  setCredentials: vi.fn(),
  verifyIdToken: vi.fn(),
}));

vi.mock("google-auth-library", () => ({
  OAuth2Client: class {
    getToken = getToken;
    setCredentials = setCredentials;
    verifyIdToken = verifyIdToken;
  },
}));

describe("getUserFromAuthCode", () => {
  it("exchanges the code, verifies the id_token for our client and returns the profile", async () => {
    const profile = { name: "Haadi", email: "h@example.com", picture: "p" };
    getToken.mockResolvedValue({ tokens: { id_token: "tok" } });
    verifyIdToken.mockResolvedValue({ getPayload: () => profile });

    await expect(getUserFromAuthCode("code-123")).resolves.toEqual(profile);
    expect(getToken).toHaveBeenCalledWith("code-123");
    expect(verifyIdToken).toHaveBeenCalledWith({
      idToken: "tok",
      audience: "test-google-client-id",
    });
  });

  it("returns an error object when the code exchange fails", async () => {
    getToken.mockRejectedValue(new Error("invalid_grant"));
    await expect(getUserFromAuthCode("bad")).resolves.toEqual({
      error: "Google Authentication failed!",
    });
  });

  it("returns an error object when the id_token cannot be verified", async () => {
    getToken.mockResolvedValue({ tokens: { id_token: "forged" } });
    verifyIdToken.mockRejectedValue(new Error("Wrong recipient"));
    await expect(getUserFromAuthCode("code")).resolves.toEqual({
      error: "Google Authentication failed!",
    });
  });
});
