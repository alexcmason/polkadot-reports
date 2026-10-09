"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "../auth";
import { hasEncryptionKey } from "../crypto";
import { str } from "../format";
import { IntegrationError } from "../integrations/http";
import { verifyKey } from "../integrations/servicem8";
import { chooseXeroTenant, disconnect, saveServiceM8, type Provider } from "../integrations/store";

const SETTINGS = "/settings";
const withError = (message: string) => `${SETTINGS}?error=${encodeURIComponent(message)}`;

export async function connectServiceM8(form: FormData) {
  const user = await requireAdmin();
  const apiKey = str(form, "api_key");
  let target = `${SETTINGS}?connected=servicem8`;
  if (!hasEncryptionKey()) target = withError("Set ENCRYPTION_KEY in Vercel before connecting ServiceM8.");
  else if (!apiKey) target = withError("Paste the ServiceM8 API key first.");
  else if (apiKey.startsWith("smk-")) {
    target = withError("That is an old plugin key. In ServiceM8 go to Settings, API Keys, and add a Read Only key.");
  } else {
    try {
      await saveServiceM8(apiKey, await verifyKey(apiKey), user.id);
    } catch (err) {
      const message =
        err instanceof IntegrationError && err.kind === "reconnect"
          ? "ServiceM8 did not accept that API key. Check it was copied in full and try again."
          : err instanceof IntegrationError
            ? err.message
            : "ServiceM8 could not be reached. Try again in a minute.";
      target = withError(message);
    }
  }
  revalidatePath("/", "layout");
  redirect(target);
}

export async function disconnectIntegration(form: FormData) {
  await requireAdmin();
  const provider = str(form, "provider");
  if (provider !== "xero" && provider !== "servicem8") redirect(withError("Unknown connection."));
  await disconnect(provider as Provider);
  revalidatePath("/", "layout");
  redirect(`${SETTINGS}?disconnected=${provider}`);
}

export async function chooseXeroOrg(form: FormData) {
  await requireAdmin();
  let target = `${SETTINGS}?connected=xero`;
  try {
    await chooseXeroTenant(str(form, "tenant_id"));
  } catch (err) {
    target = withError(err instanceof IntegrationError ? err.message : "The Xero organisation was not changed. Try again.");
  }
  revalidatePath("/", "layout");
  redirect(target);
}
