import { OAuth2Client } from "google-auth-library";

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
const redirectUri = process.env.REDIRECT_URI;

export async function getUserFromAuthCode(code) {
  const client = new OAuth2Client(clientId, clientSecret, redirectUri);

  try {
    // Exchange the code for tokens
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    // Verify the id_token we got back to extract the user profile
    const loginTicket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: clientId,
    });

    const userData = loginTicket.getPayload();

    if (userData?.email_verified !== true) {
      return { error: "Google account email is not verified!" }
    }
    return userData;
  } catch (err) {
    return { error: "Google Authentication failed!" }
  }
}