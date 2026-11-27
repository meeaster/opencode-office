import { openCheckoutLease } from "../../checkout-lease.ts";
import { OfficeError } from "../../office.ts";

const applicationLock = ".office/resolved/checkout-leases/.package-application.lock";

/** Opens and takes the lease that preparing and applying packages hold; failing either names the package application lock. */
export function applicationLease(dir: string) {
  let lease: ReturnType<typeof openCheckoutLease> | undefined;

  try {
    lease = openCheckoutLease(dir, ".package-application");
    lease.acquire(`another office sync or package update holds ${applicationLock}; retry once it finishes`);

    return lease;
  } catch (error) {
    lease?.[Symbol.dispose]();

    throw new OfficeError(`cannot take the package application lock: ${error instanceof Error ? error.message : String(error)}`);
  }
}
