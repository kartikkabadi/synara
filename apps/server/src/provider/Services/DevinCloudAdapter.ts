/**
 * DevinCloudAdapter - Devin Cloud implementation of the generic provider contract.
 *
 * Sessions run on Devin's cloud VMs. The adapter prefers `devin acp --cloud`
 * when the installed CLI supports it and falls back to the v3 REST API.
 *
 * @module DevinCloudAdapter
 */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface DevinCloudAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "devinCloud";
}

export class DevinCloudAdapter extends ServiceMap.Service<
  DevinCloudAdapter,
  DevinCloudAdapterShape
>()("synara/provider/Services/DevinCloudAdapter") {}
