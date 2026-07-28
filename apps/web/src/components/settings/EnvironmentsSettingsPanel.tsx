// FILE: EnvironmentsSettingsPanel.tsx
// Purpose: Settings → Environments panel. Lists remote execution environments,
// edits them through a disclosure form, and pre-flights connections via
// server.checkEnvironment before an environment is used in a thread.
// Layer: Settings UI components
// Exports: EnvironmentsSettingsPanel

import {
  type EnvironmentId,
  type ExecutionEnvironmentConnection,
  type ExecutionEnvironmentDescriptor,
  type ExecutionEnvironmentRuntimeType,
  PROVIDER_DISPLAY_NAMES,
  ProviderKind,
  type SshHostKeyVerificationPolicy,
} from "@synara/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { Input } from "~/components/ui/input";
import { SelectItem } from "~/components/ui/select";
import { serverEnvironmentsQueryOptions, serverQueryKeys } from "~/lib/serverReactQuery";
import { ensureNativeApi } from "~/nativeApi";
import { SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME } from "~/settingsPanelStyles";
import { toastManager } from "../ui/toast";
import { SettingsSelectControl } from "./SettingControls";
import {
  SettingsCard,
  SettingsEmptyState,
  SettingsListRow,
  SettingsSectionShell,
} from "./SettingsPanelPrimitives";
import {
  descriptorFromEnvironmentForm,
  emptyEnvironmentForm,
  type EnvironmentFormState,
  environmentFormFromDescriptor,
  validateEnvironmentForm,
} from "./environmentsSettingsModel";

const RUNTIME_TYPE_LABELS: Record<ExecutionEnvironmentRuntimeType, string> = {
  local: "Local",
  "ssh-process": "SSH process",
  "remote-synara-server": "Remote Synara server",
};

const HOST_KEY_VERIFICATION_LABELS: Record<SshHostKeyVerificationPolicy, string> = {
  "known-hosts": "Known hosts",
  "pinned-fingerprint": "Pinned fingerprint",
};

function FormField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function EnvironmentForm({
  form,
  setForm,
  errors,
  saving,
  editingId,
  onSave,
  onCancel,
}: {
  form: EnvironmentFormState;
  setForm: (updater: (current: EnvironmentFormState) => EnvironmentFormState) => void;
  errors: readonly string[];
  saving: boolean;
  editingId: string | null;
  onSave: () => void;
  onCancel: () => void;
}) {
  const patch = (partial: Partial<EnvironmentFormState>) =>
    setForm((current) => ({ ...current, ...partial }));
  return (
    <div className="space-y-3 px-4 py-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormField label="Environment ID (required, unique)">
          <Input
            size="sm"
            value={form.environmentId}
            disabled={editingId !== null}
            placeholder="my-remote-box"
            onChange={(event) => patch({ environmentId: event.target.value })}
          />
        </FormField>
        <FormField label="Display name">
          <Input
            size="sm"
            value={form.displayName}
            placeholder="My remote box"
            onChange={(event) => patch({ displayName: event.target.value })}
          />
        </FormField>
        <FormField label="Runtime type">
          <SettingsSelectControl
            value={form.runtimeType}
            ariaLabel="Runtime type"
            triggerClassName="w-full"
            valueContent={RUNTIME_TYPE_LABELS[form.runtimeType]}
            onValueChange={(value) =>
              patch({ runtimeType: value as ExecutionEnvironmentRuntimeType })
            }
          >
            {Object.entries(RUNTIME_TYPE_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SettingsSelectControl>
        </FormField>
        <FormField label="Remote binary path">
          <Input
            size="sm"
            value={form.remoteBinaryPath}
            placeholder="codex"
            onChange={(event) => patch({ remoteBinaryPath: event.target.value })}
          />
        </FormField>
        <FormField label="Host">
          <Input
            size="sm"
            value={form.host}
            placeholder="devbox.example.com"
            onChange={(event) => patch({ host: event.target.value })}
          />
        </FormField>
        <FormField label="Port">
          <Input
            size="sm"
            type="number"
            min={1}
            max={65535}
            value={form.port}
            onChange={(event) => patch({ port: event.target.value })}
          />
        </FormField>
        <FormField label="User">
          <Input
            size="sm"
            value={form.user}
            placeholder="ubuntu"
            onChange={(event) => patch({ user: event.target.value })}
          />
        </FormField>
        <FormField label="Identity file (path only)">
          <Input
            size="sm"
            value={form.identityFile}
            placeholder="~/.ssh/id_ed25519"
            onChange={(event) => patch({ identityFile: event.target.value })}
          />
        </FormField>
        <FormField label="SSH config path">
          <Input
            size="sm"
            value={form.sshConfigPath}
            placeholder="~/.ssh/config"
            onChange={(event) => patch({ sshConfigPath: event.target.value })}
          />
        </FormField>
        <FormField label="Host key verification">
          <SettingsSelectControl
            value={form.hostKeyVerification}
            ariaLabel="Host key verification"
            triggerClassName="w-full"
            valueContent={HOST_KEY_VERIFICATION_LABELS[form.hostKeyVerification]}
            onValueChange={(value) =>
              patch({ hostKeyVerification: value as SshHostKeyVerificationPolicy })
            }
          >
            {Object.entries(HOST_KEY_VERIFICATION_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SettingsSelectControl>
        </FormField>
        {form.hostKeyVerification === "pinned-fingerprint" ? (
          <FormField label="Host key fingerprint">
            <Input
              size="sm"
              value={form.hostKeyFingerprint}
              placeholder="SHA256:…"
              onChange={(event) => patch({ hostKeyFingerprint: event.target.value })}
            />
          </FormField>
        ) : null}
      </div>
      <div className="space-y-1">
        <span className="text-[11px] font-medium text-muted-foreground">Providers</span>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {ProviderKind.literals.map((kind) => (
            <label key={kind} className="flex items-center gap-1.5 text-xs text-foreground">
              <Checkbox
                checked={form.providerKinds.includes(kind)}
                onCheckedChange={(checked) =>
                  setForm((current) => ({
                    ...current,
                    providerKinds: checked
                      ? [...current.providerKinds, kind]
                      : current.providerKinds.filter((candidate) => candidate !== kind),
                  }))
                }
              />
              {PROVIDER_DISPLAY_NAMES[kind]}
            </label>
          ))}
        </div>
      </div>
      {errors.length > 0 ? (
        <ul className="space-y-0.5 text-xs text-destructive">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <Button size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="xs" variant="secondary" disabled={saving} onClick={onSave}>
          {saving ? "Saving…" : editingId !== null ? "Save changes" : "Add environment"}
        </Button>
      </div>
    </div>
  );
}

function connectionSummary(connection: ExecutionEnvironmentConnection): string {
  const health = connection.healthCheckResult;
  const parts = [`Status: ${connection.connectionStatus}`];
  if (health) {
    parts.push(`health check ${health.status}${health.message ? ` — ${health.message}` : ""}`);
  }
  return parts.join(", ");
}

function EnvironmentCheckForm({
  environment,
  onClose,
}: {
  environment: ExecutionEnvironmentDescriptor;
  onClose: () => void;
}) {
  const [remoteWorkspaceRoot, setRemoteWorkspaceRoot] = useState("");
  const [providerKind, setProviderKind] = useState<ProviderKind>(
    environment.capabilities.providerKinds[0] ?? "codex",
  );
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runCheck = async () => {
    if (remoteWorkspaceRoot.trim() === "") {
      setError("Remote workspace root is required.");
      return;
    }
    setPending(true);
    setResult(null);
    setError(null);
    try {
      const { connection } = await ensureNativeApi().server.checkEnvironment({
        executionProfile: {
          environmentId: environment.environmentId,
          providerKind,
          remoteWorkspaceRoot: remoteWorkspaceRoot.trim(),
        },
      });
      setResult(connectionSummary(connection));
    } catch (checkError) {
      setError(checkError instanceof Error ? checkError.message : "Environment check failed.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="mt-2 space-y-2 rounded-lg border border-border/70 bg-background/50 p-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormField label="Remote workspace root">
          <Input
            size="sm"
            value={remoteWorkspaceRoot}
            placeholder="/home/user/project"
            onChange={(event) => setRemoteWorkspaceRoot(event.target.value)}
          />
        </FormField>
        <FormField label="Provider">
          <SettingsSelectControl
            value={providerKind}
            ariaLabel="Check provider"
            triggerClassName="w-full"
            valueContent={PROVIDER_DISPLAY_NAMES[providerKind]}
            onValueChange={(value) => setProviderKind(value as ProviderKind)}
          >
            {ProviderKind.literals.map((kind) => (
              <SelectItem key={kind} value={kind}>
                {PROVIDER_DISPLAY_NAMES[kind]}
              </SelectItem>
            ))}
          </SettingsSelectControl>
        </FormField>
      </div>
      {result ? <p className="text-xs text-foreground">{result}</p> : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex items-center justify-end gap-2">
        <Button size="xs" variant="ghost" onClick={onClose}>
          Close
        </Button>
        <Button size="xs" variant="secondary" disabled={pending} onClick={() => void runCheck()}>
          {pending ? "Checking…" : "Run check"}
        </Button>
      </div>
    </div>
  );
}

export function EnvironmentsSettingsPanel({ active }: { readonly active: boolean }) {
  const queryClient = useQueryClient();
  const environmentsQuery = useQuery(serverEnvironmentsQueryOptions());
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<EnvironmentFormState>(emptyEnvironmentForm);
  const [errors, setErrors] = useState<readonly string[]>([]);
  const [saving, setSaving] = useState(false);
  const [checkingId, setCheckingId] = useState<string | null>(null);

  const environments = useMemo(
    () => environmentsQuery.data?.environments ?? [],
    [environmentsQuery.data?.environments],
  );

  const refresh = () => queryClient.invalidateQueries({ queryKey: serverQueryKeys.environments() });

  const openCreateForm = () => {
    setEditingId(null);
    setForm(emptyEnvironmentForm());
    setErrors([]);
    setFormOpen(true);
  };

  const openEditForm = (descriptor: ExecutionEnvironmentDescriptor) => {
    setEditingId(descriptor.environmentId);
    setForm(environmentFormFromDescriptor(descriptor));
    setErrors([]);
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditingId(null);
    setErrors([]);
  };

  const saveEnvironment = async () => {
    const validationErrors = validateEnvironmentForm(form, {
      existingIds: new Set(environments.map((environment) => environment.environmentId)),
      editingId,
    });
    setErrors(validationErrors);
    if (validationErrors.length > 0) return;
    const existing = environments.find((environment) => environment.environmentId === editingId);
    setSaving(true);
    try {
      await ensureNativeApi().server.upsertEnvironment({
        descriptor: descriptorFromEnvironmentForm(form, existing),
      });
      await refresh();
      closeForm();
    } catch (error) {
      setErrors([error instanceof Error ? error.message : "Could not save the environment."]);
    } finally {
      setSaving(false);
    }
  };

  const deleteEnvironment = async (descriptor: ExecutionEnvironmentDescriptor) => {
    const api = ensureNativeApi();
    const confirmed = await api.dialogs.confirm(
      `Remove environment "${descriptor.label}"?\n\nThreads configured to run on it will no longer find it.`,
    );
    if (!confirmed) return;
    try {
      await api.server.removeEnvironment({
        environmentId: descriptor.environmentId as EnvironmentId,
      });
      await refresh();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not remove environment",
        description: error instanceof Error ? error.message : "Unable to remove the environment.",
      });
    }
  };

  if (!active) return null;

  return (
    <div className="space-y-6">
      <SettingsSectionShell
        title="Execution environments"
        action={
          <Button size="xs" variant="outline" onClick={formOpen ? closeForm : openCreateForm}>
            {formOpen ? "Close" : "Add environment"}
          </Button>
        }
      >
        <SettingsCard divided={false}>
          <DisclosureRegion open={formOpen}>
            <EnvironmentForm
              form={form}
              setForm={setForm}
              errors={errors}
              saving={saving}
              editingId={editingId}
              onSave={() => void saveEnvironment()}
              onCancel={closeForm}
            />
          </DisclosureRegion>
          {!formOpen ? (
            <div className={`px-4 py-3 ${SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME}`}>
              Register remote hosts Synara can run providers on. Only paths and fingerprints are
              stored — never keys or passwords.
            </div>
          ) : null}
        </SettingsCard>
      </SettingsSectionShell>

      {environmentsQuery.isLoading ? (
        <SettingsEmptyState layout="status">Loading environments…</SettingsEmptyState>
      ) : environmentsQuery.isError ? (
        <SettingsEmptyState layout="status" tone="destructive">
          {environmentsQuery.error instanceof Error
            ? environmentsQuery.error.message
            : "Unable to load environments."}
        </SettingsEmptyState>
      ) : environments.length === 0 ? (
        <SettingsEmptyState>No environments registered yet.</SettingsEmptyState>
      ) : (
        <SettingsSectionShell title="Registered environments">
          <SettingsCard>
            {environments.map((environment) => (
              <SettingsListRow
                key={environment.environmentId}
                align="start"
                title={environment.label}
                description={
                  <div className="space-y-1">
                    <code className="block truncate text-[11px] text-muted-foreground">
                      {environment.environmentId}
                    </code>
                    <div className={SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME}>
                      {RUNTIME_TYPE_LABELS[environment.runtime?.runtimeType ?? "local"]}
                      {environment.transport
                        ? ` · ${environment.transport.user ? `${environment.transport.user}@` : ""}${environment.transport.host}:${environment.transport.port}`
                        : ""}
                      {environment.capabilities.providerKinds.length > 0
                        ? ` · ${environment.capabilities.providerKinds
                            .map((kind) => PROVIDER_DISPLAY_NAMES[kind])
                            .join(", ")}`
                        : ""}
                    </div>
                    {environment.connection ? (
                      <div className={SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME}>
                        {connectionSummary(environment.connection)}
                      </div>
                    ) : null}
                    <DisclosureRegion open={checkingId === environment.environmentId}>
                      <EnvironmentCheckForm
                        environment={environment}
                        onClose={() => setCheckingId(null)}
                      />
                    </DisclosureRegion>
                  </div>
                }
                actions={
                  <>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() =>
                        setCheckingId((current) =>
                          current === environment.environmentId ? null : environment.environmentId,
                        )
                      }
                    >
                      Check
                    </Button>
                    <Button size="xs" variant="outline" onClick={() => openEditForm(environment)}>
                      Edit
                    </Button>
                    <Button
                      size="xs"
                      variant="destructive"
                      onClick={() => void deleteEnvironment(environment)}
                    >
                      Delete
                    </Button>
                  </>
                }
              />
            ))}
          </SettingsCard>
        </SettingsSectionShell>
      )}
    </div>
  );
}
