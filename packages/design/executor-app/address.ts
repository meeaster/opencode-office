// Where Doop opens, by the rule the package's compose file (BETTER_AUTH_URL) and plugin follow too.
// It imports nothing, so the package's tests check the three agree.

/** The design package's settings this rule reads, as office.yaml may give them. */
export type AddressSettings = { port: number | string; url: string; executor_app: boolean | string; oauth: boolean | string };

/** Whether sessions sign in to Doop through the Executor app. */
export function oauthOffered(settings: AddressSettings): boolean {
  return String(settings.executor_app) === "true" && String(settings.oauth) === "true";
}

/**
 * The address the browser opens Doop at, which Doop advertises: the url setting; else, with OAuth
 * through the Executor app, http://doop.localhost:<port>, a name the browser and Executor's
 * container both reach; else http://localhost:<port>.
 */
export function browserAddress(settings: AddressSettings): string {
  const url = settings.url.replace(/\/+$/, "");

  if (url !== "") return url;

  return oauthOffered(settings) ? `http://doop.localhost:${settings.port}` : `http://localhost:${settings.port}`;
}
