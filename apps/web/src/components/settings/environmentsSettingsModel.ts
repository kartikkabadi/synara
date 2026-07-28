// FILE: environmentsSettingsModel.tsx
// Purpose: Pure form model for the Environments settings panel — form state,
// validation mirroring the contracts Effect Schema, and descriptor mapping.
// Layer: Settings UI logic (no React)
// Exports: EnvironmentFormState, emptyEnvironmentForm, environmentFormFromDescriptor,
//          validateEnvironmentForm, descriptorFromEnvironmentForm

import type {
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  ExecutionEnvironmentRuntimeType,
  ProviderKind,
  SshHostKeyVerificationPolicy,
} from "@synara/contracts";

export type EnvironmentFormState = {
  environmentId: string;
  displayName: string;
  runtimeType: ExecutionEnvironmentRuntimeType;
  host: string;
  port: string;
  user: string;
  identityFile: string;
  sshConfigPath: string;
  hostKeyVerification: SshHostKeyVerificationPolicy;
  hostKeyFingerprint: string;
  remoteBinaryPath: string;
  providerKinds: readonly ProviderKind[];
};

export function emptyEnvironmentForm(): EnvironmentFormState {
  return {
    environmentId: "",
    displayName: "",
    runtimeType: "ssh-process",
    host: "",
    port: "22",
    user: "",
    identityFile: "",
    sshConfigPath: "",
    hostKeyVerification: "known-hosts",
    hostKeyFingerprint: "",
    remoteBinaryPath: "codex",
    providerKinds: ["codex"],
  };
}

export function environmentFormFromDescriptor(
  descriptor: ExecutionEnvironmentDescriptor,
): EnvironmentFormState {
  return {
    environmentId: descriptor.environmentId,
    displayName: descriptor.label,
    runtimeType: descriptor.runtime?.runtimeType ?? "ssh-process",
    host: descriptor.transport?.host ?? "",
    port: String(descriptor.transport?.port ?? 22),
    user: descriptor.transport?.user ?? "",
    identityFile: descriptor.transport?.identityFile ?? "",
    sshConfigPath: descriptor.transport?.sshConfigPath ?? "",
    hostKeyVerification: descriptor.transport?.hostKeyVerification ?? "known-hosts",
    hostKeyFingerprint: descriptor.transport?.hostKeyFingerprint ?? "",
    remoteBinaryPath: descriptor.runtime?.remoteBinaryPath ?? "codex",
    providerKinds: descriptor.capabilities.providerKinds,
  };
}

// Paths and fingerprints only — never key or password material. Multi-line
// values and PEM headers are the signature of pasted secrets.
function looksLikeSecretMaterial(value: string): boolean {
  return value.includes("\n") || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value);
}

export function validateEnvironmentForm(
  form: EnvironmentFormState,
  options: {
    existingIds: ReadonlySet<string>;
    editingId: string | null;
  },
): string[] {
  const errors: string[] = [];
  const environmentId = form.environmentId.trim();
  if (environmentId.length === 0) {
    errors.push("Environment ID is required.");
  } else if (environmentId !== options.editingId && options.existingIds.has(environmentId)) {
    errors.push(`An environment with ID "${environmentId}" already exists.`);
  }
  if (form.runtimeType !== "local" && form.host.trim().length === 0) {
    errors.push("Host is required for remote runtimes.");
  }
  const port = Number(form.port.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    errors.push("Port must be an integer between 1 and 65535.");
  }
  if (form.hostKeyVerification === "pinned-fingerprint" && form.hostKeyFingerprint.trim() === "") {
    errors.push("A host key fingerprint is required when pinning is enabled.");
  }
  for (const [label, value] of [
    ["Identity file", form.identityFile],
    ["SSH config path", form.sshConfigPath],
    ["Host key fingerprint", form.hostKeyFingerprint],
  ] as const) {
    if (looksLikeSecretMaterial(value)) {
      errors.push(`${label} must be a path or fingerprint, never key material.`);
    }
  }
  if (form.providerKinds.length === 0) {
    errors.push("Select at least one provider.");
  }
  return errors;
}

const optionalTrimmed = (value: string) => {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

/** Builds the upsert payload, preserving server-owned fields from the existing descriptor. */
export function descriptorFromEnvironmentForm(
  form: EnvironmentFormState,
  existing: ExecutionEnvironmentDescriptor | undefined,
): ExecutionEnvironmentDescriptor {
  const environmentId = form.environmentId.trim() as EnvironmentId;
  const remoteBinaryPath = optionalTrimmed(form.remoteBinaryPath);
  const user = optionalTrimmed(form.user);
  const identityFile = optionalTrimmed(form.identityFile);
  const sshConfigPath = optionalTrimmed(form.sshConfigPath);
  const hostKeyFingerprint = optionalTrimmed(form.hostKeyFingerprint);
  return {
    environmentId,
    label: form.displayName.trim() || environmentId,
    platform: existing?.platform ?? { os: "unknown", arch: "other" },
    serverVersion: existing?.serverVersion ?? "unknown",
    capabilities: {
      repositoryIdentity: existing?.capabilities.repositoryIdentity ?? false,
      shell: existing?.capabilities.shell ?? false,
      browser: existing?.capabilities.browser ?? false,
      computerUse: existing?.capabilities.computerUse ?? false,
      devServerForwarding: existing?.capabilities.devServerForwarding ?? false,
      checkpoint: existing?.capabilities.checkpoint ?? false,
      sync: existing?.capabilities.sync ?? false,
      reconnect: existing?.capabilities.reconnect ?? false,
      providerKinds: form.providerKinds,
    },
    runtime: {
      ...existing?.runtime,
      runtimeType: form.runtimeType,
      supervisor: existing?.runtime?.supervisor ?? "none",
      forwardedEnvNames: existing?.runtime?.forwardedEnvNames ?? [],
      ...(remoteBinaryPath ? { remoteBinaryPath } : {}),
    },
    ...(form.host.trim() !== ""
      ? {
          transport: {
            host: form.host.trim(),
            port: Number(form.port.trim()),
            hostKeyVerification: form.hostKeyVerification,
            ...(user ? { user } : {}),
            ...(identityFile ? { identityFile } : {}),
            ...(sshConfigPath ? { sshConfigPath } : {}),
            ...(form.hostKeyVerification === "pinned-fingerprint" && hostKeyFingerprint
              ? { hostKeyFingerprint }
              : {}),
          },
        }
      : {}),
    ...(existing?.connection ? { connection: existing.connection } : {}),
  };
}
