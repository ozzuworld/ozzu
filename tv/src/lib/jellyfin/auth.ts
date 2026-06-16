// Jellyfin auth. Quick Connect is the primary path (the user approves a code on
// their phone — ideal for a TV where typing a password with a remote is painful).
// Username/password is the fallback. getUserApi()'s augmented methods auto-set the
// access token on the Api instance for both paths.

import { getQuickConnectApi, getUserApi } from "@jellyfin/sdk/lib/utils/api";
import { getApi, setUserId } from "./client";
import { saveSession, type Session } from "./storage";

export interface QuickConnectInit {
  secret: string;
  code: string;
}

export async function quickConnectEnabled(): Promise<boolean> {
  try {
    const { data } = await getQuickConnectApi(getApi()).getQuickConnectEnabled();
    return !!data;
  } catch {
    return false;
  }
}

export async function quickConnectInitiate(): Promise<QuickConnectInit> {
  const { data } = await getQuickConnectApi(getApi()).initiateQuickConnect();
  return { secret: data.Secret || "", code: data.Code || "" };
}

/** Poll until the user approves the code on their phone. */
export async function quickConnectPoll(secret: string): Promise<boolean> {
  const { data } = await getQuickConnectApi(getApi()).getQuickConnectState({ secret });
  return !!data.Authenticated;
}

export async function quickConnectAuthenticate(secret: string): Promise<Session> {
  const { data } = await getUserApi(getApi()).authenticateWithQuickConnect({
    quickConnectDto: { Secret: secret },
  });
  return persist(data);
}

export async function loginWithPassword(username: string, password: string): Promise<Session> {
  const { data } = await getUserApi(getApi()).authenticateUserByName({
    authenticateUserByName: { Username: username, Pw: password },
  });
  return persist(data);
}

// AuthenticationResult — token is already applied to the Api by getUserApi's
// augmented methods; we just shape + persist the session.
function persist(result: any): Session {
  const session: Session = {
    accessToken: result?.AccessToken || "",
    userId: result?.User?.Id || "",
    userName: result?.User?.Name || undefined,
    serverId: result?.ServerId || undefined,
  };
  setUserId(session.userId);
  void saveSession(session);
  return session;
}
