# Azure Files SMB Security — Setting-by-Setting Compatibility with Azure Functions

**Scope:** Windows **Consumption (Y1)** and Windows/Linux **Elastic Premium** Function App plans that use the platform-managed Azure Files **content share** (i.e. apps with `WEBSITE_CONTENTAZUREFILECONNECTIONSTRING` / `WEBSITE_CONTENTSHARE` set — the default for these plans).

**Test subject:** `temp-func-smb-repro-uw36s0` (Windows Consumption Y1, Node.js, Functions `~4`), resource group `Temp_Function_RG`, subscription `6a3bb170-5159-4bff-860b-aa74fb762697`. Support case **2606020040009172** (Sev B).

**Full test report with timestamped log evidence (Application Insights, Azure Activity Log, direct SMB session tests):**
👉 **https://claude.ai/code/artifact/3d52a5f7-8401-4ef8-bba4-1a0e5144d182**

This document breaks that testing down **setting by setting** — every checkbox on the storage account's *File share settings → Security* blade — with what's supported, what isn't, and why, so you can build any custom profile with full knowledge of the compatibility boundary.

---

## Quick-reference matrix

| Setting group | Option | Verdict | Required for this app? |
|---|---|:---:|:---:|
| Encryption in transit | Require Encryption in Transit for SMB | ✅ Compatible | Recommended (no downside observed) |
| Protocol version | SMB 2.1 | ✅ Compatible, but removable | No |
| Protocol version | SMB 3.0 | ✅ Compatible, but removable | No |
| Protocol version | **SMB 3.1.1** | ✅ Compatible | **Yes — keep** |
| Authentication | **NTLM v2** | ✅ Compatible | **Yes — required, do not remove** |
| Authentication | Kerberos | ✅ Compatible, but removable | No (tested — see §3) |
| Channel encryption | AES-128-CCM | ✅ Compatible, but removable | No |
| Channel encryption | **AES-128-GCM** | ✅ Compatible | **Yes — required, do not remove** |
| Channel encryption | AES-256-GCM | ✅ Compatible | No (fine to keep alongside AES-128-GCM) |
| Kerberos ticket encryption | RC4-HMAC | ✅ Compatible, but removable | No |
| Kerberos ticket encryption | AES-256 | ✅ Compatible | Recommended (strongest available) |

The two rows marked **required** are the actual compatibility boundary. Everything else is either always fine to disable, or fine either way.

---

## Why the Maximum Security preset fails, and the exact delta to fix it

**Assumption for this section:** the storage account is used **only** by this Windows Function App — nothing else (no domain-joined VM, no AD DS/Microsoft Entra Kerberos identity, no other share consumer) touches it. This changes the answer for one setting (Kerberos) versus a shared account.

The portal's **Maximum security** preset, exactly as shown on your Security blade, sets:

| Setting group | Maximum security preset (as shipped) |
|---|---|
| SMB protocol versions | SMB 3.1.1 only |
| Authentication mechanisms | **Kerberos only** (NTLM v2 unchecked) |
| SMB channel encryption | **AES-256-GCM only** |
| Kerberos ticket encryption | AES-256 only |

Two of these four are why it breaks the app. Two are already fine and need no change:

| Setting | Preset value | Breaks the app? | Why |
|---|---|:---:|---|
| SMB protocol versions | SMB 3.1.1 only | **No** | The Functions platform's SMB client already negotiates SMB 3.1.1 by default — no change needed. |
| Authentication mechanisms | Kerberos only | **Yes** | The content-share mount authenticates exclusively via NTLMv2 (storage-account-key credential). Azure Files has no identity-based/Kerberos connection option for `WEBSITE_CONTENTAZUREFILECONNECTIONSTRING` at all, so Kerberos-only removes the *only* path this mount has. |
| SMB channel encryption | AES-256-GCM only | **Yes** | Default-configured SMB clients — including the one the Functions platform itself uses — don't negotiate AES-256-GCM without a manual, per-client `Set-SmbClientConfiguration` override that cannot be applied to Functions' platform-managed, multi-tenant compute. |
| Kerberos ticket encryption | AES-256 only | **No** | Moot either way — this app never actually uses a Kerberos ticket, so its cipher choice has no effect on it. |

### The exact delta: what to remove, what to add, and why

**Remove from the preset:**
- **Kerberos**, as an authentication mechanism. This isn't the thing that's broken — it's dead weight. This app never authenticates via Kerberos, so leaving it checked only adds a second accepted authentication path to the storage account without adding any capability this app actually uses. Since nothing else uses this account (per the stated scenario), there's no reason to keep it enabled.

**Add back to the preset:**
- **NTLM v2**, as an authentication mechanism — **mandatory**. Without it, the content-share mount cannot authenticate at all; this is the setting that produced the crash loop in §3.
- **AES-128-GCM**, as a channel-encryption cipher — **mandatory**. Without it, no default-configured SMB client can complete a session against the share; this is the setting that kept the app broken even after NTLM v2 was restored, in §4.

**Leave unchanged:**
- SMB protocol versions (SMB 3.1.1 only) — already correct.
- Kerberos ticket encryption (AES-256 only) — harmless to leave as-is even with Kerberos unchecked; it costs nothing and keeps the account hardened if Kerberos is ever turned back on later for some other consumer.

### Result: the tightest profile that actually works, for a storage account dedicated to this Function App

| Setting | Value | vs. Maximum security preset |
|---|---|---|
| Require Encryption in Transit for SMB | Enabled | Unchanged |
| SMB protocol versions | SMB 3.1.1 only | Unchanged |
| Authentication mechanisms | **NTLM v2 only** | Swapped — Kerberos removed, NTLM v2 added |
| SMB channel encryption | **AES-128-GCM + AES-256-GCM** | Widened — AES-128-GCM added back |
| Kerberos ticket encryption | AES-256 only | Unchanged |

This is narrower than the preset in the one dimension that actually matters — it uses the single authentication mechanism that works, instead of the single one that doesn't — and only wider in channel encryption, where an AES-256-GCM-only restriction isn't achievable for this compute type at all. Comparing "checkbox count" between the two isn't meaningful: a preset that can't authenticate provides zero effective security, only downtime.

We tested this exact combination directly: **NTLM v2 only + AES-128-GCM;AES-256-GCM + SMB 3.1.1 only + AES-256 ticket encryption** restarted cleanly (site healthy in ~10s) and drained a fresh queue message in ~20s with no errors — see §3 and §4 for the full evidence.

**If this storage account is ever shared** with something that genuinely uses Kerberos (a domain-joined VM, or an AD DS/Microsoft Entra Kerberos identity accessing a different share on the same account), re-check Kerberos alongside NTLM v2 — it costs this Function App nothing and restores that other consumer's access path. That variant is what's shown as the default recommendation further down, for accounts where exclusivity isn't guaranteed.

---

## 1. Require Encryption in Transit for SMB

| | |
|---|---|
| **Setting** | `Require Encryption in Transit for SMB` — Enabled / Disabled |
| **Verdict** | ✅ **Fully compatible.** Enable it. |
| **Tested as** | Enabled in every profile tested (baseline, Maximum security, and the final recommended profile) |

**Why it's safe:** this setting only forces SMB sessions to negotiate SMB 3.x *with* channel encryption — it rejects SMB 2.1 and unencrypted SMB 3.x, but doesn't touch authentication mechanism or which cipher is chosen. The Functions platform's SMB client already negotiates SMB 3.1.1 with encryption by default, so enabling this had zero effect on any test — every profile that failed, failed for a different reason (authentication or cipher restriction), never because of this setting.

**Reference:** [SMB file shares in Azure Files — Encryption in transit](https://learn.microsoft.com/en-us/azure/storage/files/files-smb-protocol#encryption-in-transit) — *"For new storage accounts created by using the Azure portal, Require Encryption in Transit for SMB is enabled by default."*

---

## 2. SMB protocol versions

| Version | Verdict | Notes |
|---|:---:|---|
| SMB 2.1 | ✅ Compatible, but **removable** | Never required by this app in any passing test |
| SMB 3.0 | ✅ Compatible, but **removable** | Never required by this app in any passing test |
| **SMB 3.1.1** | ✅ **Compatible — keep** | Present, and sufficient alone, in every working profile tested |

**Why SMB 2.1 and 3.0 can be dropped safely:** every profile we tested — including the fully working baseline *and* the final recommended hardened profile — restricted this field to `SMB3.1.1` only, with no compatibility impact whatsoever. The Functions platform's own SMB client negotiates SMB 3.1.1 by default; it never needs to fall back to an older dialect for this scenario.

**A note on SMB 2.1 specifically:** if *Require Encryption in Transit for SMB* is enabled, SMB 2.1 is unusable regardless of whether its checkbox is ticked — SMB 2.1 has no encryption support, so the portal shows it checked-but-greyed with a warning ("The SMB 2.1 protocol is enabled but cannot be used to access the file share"). This matches what you saw in the Maximum compatibility screenshot. It's cosmetic; the effective behavior is identical to explicitly disabling it.

**Reference:** [SMB file shares in Azure Files — SMB security settings](https://learn.microsoft.com/en-us/azure/storage/files/files-smb-protocol#smb-security-settings) — *"SMB 2.1 is disallowed if Require Encryption in Transit for SMB is enabled … because SMB 2.1 doesn't support encryption in transit."*

---

## 3. Authentication mechanisms

This is **the single most important setting** in this document — and the one that actually broke the app in your original observation.

| Mechanism | Verdict | Notes |
|---|:---:|---|
| **NTLM v2** | ❌ **Cannot be removed** | The content-share mount authenticates exclusively via NTLMv2 |
| Kerberos | ✅ Compatible, and **removable** | Tested independently — see below |

### Why NTLM v2 is mandatory

`WEBSITE_CONTENTAZUREFILECONNECTIONSTRING` is always a **storage-account-key** connection string. Azure Files has no identity-based (Kerberos / Microsoft Entra) connection option for this app setting at all — the Functions platform mounts the content share the same way regardless of plan, using the account key as the SMB credential, which negotiates as **NTLMv2**.

Selecting **Kerberos only** — exactly what the portal's *Maximum security* preset does — removes the only authentication path this mount can use. We proved this two ways:

1. **Live reproduction:** switching to Kerberos-only and restarting the Function App produced a sustained crash loop (`FAILED TO INITIALIZE RUN FROM PACKAGE.txt`, unrecovered for 20+ minutes), with an Application Insights exception reading `The user name or password is incorrect. : 'C:\home\data\Functions\sampledata'.` — a literal SMB auth rejection.
2. **Restoring NTLMv2 alone was necessary** to bring the app back — but see §4, because it was not *sufficient* by itself in our first attempt (a separate cipher restriction was still blocking it).

### Kerberos: tested and confirmed removable

Because Kerberos is never actually used for this mount, we tested dropping it entirely — `NTLM v2` selected, `Kerberos` unchecked:

```
authenticationMethods: "NTLMv2"   (Kerberos unchecked)
```

Result: restarted cleanly (site healthy in ~10s), and a fresh queue message was picked up and processed in ~20s with no errors. **Kerberos can be safely unchecked for this app's content-share mount specifically.**

**One caveat:** if the *same storage account* is also used by anything that genuinely authenticates via Kerberos (e.g. a domain-joined VM or AD DS/Microsoft Entra Kerberos identity accessing a *different* share on that account), removing Kerberos would break that other consumer. For an account used **only** as this Function App's `AzureWebJobsStorage` + content share (as in this test environment), it's safe to remove. If in doubt, leaving Kerberos checked alongside NTLMv2 costs nothing — it's simply unused by this mount.

**Reference:** [SMB file shares in Azure Files — SMB security settings](https://learn.microsoft.com/en-us/azure/storage/files/files-smb-protocol#smb-security-settings) — *"Removing NTLMv2 disallows using the storage account key to mount the Azure file share."*
**Reference:** [Storage considerations for Azure Functions](https://learn.microsoft.com/en-us/azure/azure-functions/storage-considerations#create-an-app-without-azure-files) — *"Azure Files doesn't currently support identity-based connections"* for the content-share app settings.
**Reference:** [Overview — Azure Files identity-based authentication](https://learn.microsoft.com/en-us/azure/storage/files/storage-files-active-directory-overview) — Kerberos access requires AD DS, Microsoft Entra Domain Services, or Microsoft Entra Kerberos, all of which need a domain-joined or Entra-joined client. Azure Functions' platform-managed, multi-tenant compute is none of these, so it structurally cannot use Kerberos for this mount.

---

## 4. SMB channel encryption

This is the **second, less-documented compatibility boundary** we found — and it compounds with §3, not replaces it.

| Cipher | Verdict | Notes |
|---|:---:|---|
| AES-128-CCM | ✅ Compatible, and **removable** | Never required in any test |
| **AES-128-GCM** | ❌ **Cannot be removed** | Required — see below |
| AES-256-GCM | ✅ Compatible | Fine to keep enabled alongside AES-128-GCM |

### Why AES-128-GCM is mandatory (the non-obvious finding)

The portal's **Maximum security** preset restricts channel encryption to **AES-256-GCM only**. Microsoft's own documentation carries a caveat about this exact restriction:

> *"If you select only AES-256-GCM, you need to tell connecting clients to use it by opening a PowerShell terminal as administrator on each client and running `Set-SmbClientConfiguration -EncryptionCiphers "AES_256_GCM" -Confirm:$false`."*
> — [SMB file shares in Azure Files — SMB security settings](https://learn.microsoft.com/en-us/azure/storage/files/files-smb-protocol#smb-security-settings)

In other words: even a fully current, AES-256-GCM-*capable* Windows client will not necessarily negotiate that cipher unless it has been **individually, manually reconfigured** to prefer/require it. Azure Functions' Consumption/Premium compute is platform-managed and multi-tenant — there is no way for a customer to run that command against it.

We confirmed this empirically, independent of the Function App, by mounting the same file share directly from a Windows 11 Pro (build 26100 / 24H2) client using the storage account key:

- With **NTLMv2 + Kerberos** enabled but channel encryption restricted to **AES-256-GCM only** → `New-PSDrive` failed with **`Access is denied`**, even though `Get-SmbClientConfiguration` on that same client reported `AES_256_GCM` as an available cipher.
- With channel encryption relaxed to **AES-128-GCM + AES-256-GCM** (same client, no other change) → the mount **succeeded immediately**.

The Function App showed the identical pattern: restoring NTLMv2 alone (while still restricted to AES-256-GCM only) did **not** clear the crash loop, even across two more restarts and a full stop/start cycle. Only *also* allowing AES-128-GCM let the app recover — cleanly, immediately, and durably across a subsequent clean-restart validation.

**Conclusion: an AES-256-GCM-only channel encryption restriction is not achievable for this scenario today**, independent of the authentication mechanism setting. AES-128-GCM must remain enabled.

**Reference:** [SMB file shares in Azure Files — SMB security settings](https://learn.microsoft.com/en-us/azure/storage/files/files-smb-protocol#smb-security-settings)
**Reference:** [SMB file shares in Azure Files — Windows SMB support table](https://learn.microsoft.com/en-us/azure/storage/files/files-smb-protocol#windows-smb-support-and-azure-files-features) — *"AES-128-GCM is negotiated by default on Windows 10, version 21H1 for performance reasons."*

---

## 5. Kerberos ticket encryption

| Cipher | Verdict | Notes |
|---|:---:|---|
| RC4-HMAC | ✅ Compatible, and **removable** | Legacy/weak cipher, no compatibility dependency found |
| **AES-256** | ✅ Compatible | Recommended — strongest available, present in every profile tested |

**Why this setting is low-risk either way:** Kerberos ticket encryption only matters when the Kerberos authentication mechanism is actually exercised. Since this app's content-share mount authenticates via NTLMv2 (§3), the Kerberos ticket cipher choice has **no effect on it at all** — RC4-HMAC was present in the working baseline and absent in every other profile tested (including the ones that failed for unrelated reasons), with zero correlation to any failure.

**Recommendation:** restrict to **AES-256 only** anyway. It costs nothing for this app, and it hardens the account as a whole in case anything else ever authenticates to it via Kerberos (see the caveat in §3).

**Reference:** [SMB file shares in Azure Files — SMB security settings](https://learn.microsoft.com/en-us/azure/storage/files/files-smb-protocol#smb-security-settings) — *"Supported encryption algorithms are AES-256 (strongly recommended) and RC4-HMAC."*

---

## Recommended Custom profile for maximum achievable security

Two variants, depending on whether this storage account is dedicated to this Function App or shared with something else that uses Kerberos:

| Setting | **Exclusive use** (only this Function App) | **Shared account** (something else may use Kerberos) |
|---|---|---|
| Require Encryption in Transit for SMB | Enabled | Enabled |
| SMB protocol versions | SMB 3.1.1 only | SMB 3.1.1 only |
| Authentication mechanisms | **NTLM v2 only** | **NTLM v2 + Kerberos** |
| SMB channel encryption | AES-128-GCM + AES-256-GCM | AES-128-GCM + AES-256-GCM |
| Kerberos ticket encryption | AES-256 only | AES-256 only |

Both are validated: each survived clean restart cycles with the queue draining in under 20 seconds, with no crash-loop behavior. If you're not certain nothing else authenticates to this account via Kerberos, default to the shared-account variant — it costs this Function App nothing to leave Kerberos checked.

### Apply via Azure CLI

```bash
# Exclusive-use variant (drop --auth-methods to "NTLMv2" only)
az storage account file-service-properties update -n <storage-account> -g <resource-group> \
  --versions "SMB3.1.1" \
  --auth-methods "NTLMv2" \
  --kerb-ticket-encryption "AES-256" \
  --channel-encryption "AES-128-GCM;AES-256-GCM"

# Shared-account variant — use this instead if anything else on the account uses Kerberos:
#   --auth-methods "NTLMv2;Kerberos"

# Always restart immediately after any SMB profile change — an already-mounted
# instance keeps working regardless of the new setting (SMB Continuous
# Availability), so a restart is the only way to force re-evaluation.
az functionapp restart -g <resource-group> -n <function-app-name>
```

### Apply via Azure PowerShell

```powershell
# Exclusive-use variant (use -SmbAuthenticationMethod "NTLMv2","Kerberos" for a shared account)
Update-AzStorageFileServiceProperty `
  -ResourceGroupName <resource-group> `
  -StorageAccountName <storage-account> `
  -SmbProtocolVersion "SMB3.1.1" `
  -SmbAuthenticationMethod "NTLMv2" `
  -SmbKerberosTicketEncryption "AES-256" `
  -SmbChannelEncryption "AES-128-GCM","AES-256-GCM"

Restart-AzFunctionApp -ResourceGroupName <resource-group> -Name <function-app-name>
```

### Apply via the Azure portal

1. Storage account → **Data storage → File shares** → **File share settings** → **Security**.
2. Profile → **Custom**.
3. SMB protocol versions: check **SMB 3.1.1** only.
4. Authentication mechanisms: check **NTLM v2**. Check **Kerberos** too, unless you've confirmed nothing else on the account needs it (see the delta discussion above).
5. SMB channel encryption: check **AES-128-GCM** and **AES-256-GCM** (leave AES-128-CCM unchecked).
6. Kerberos ticket encryption: check **AES-256** only.
7. **Save**, then restart the Function App from its Overview blade to force the new mount to take effect.

### Operational gotcha: restart alone may not be enough to recover

If the app has already entered the crash-loop state (from a bad profile applied earlier), reverting the profile and restarting **may not clear it** — the platform can leave a `FAILED TO INITIALIZE RUN FROM PACKAGE.txt` sentinel on the content share that keeps forcing the host to shut down regardless of whether the mount now works. In our testing, a full stop/start cycle did not clear this either. Recovery required restoring a working profile **and then triggering a fresh deployment** (`func azure functionapp publish`, or any redeploy). Build this into any rollback runbook — don't assume "revert + restart" is always sufficient.

---

## Scope note

This guidance applies specifically to **Windows Consumption** and **Windows/Linux Elastic Premium** plans, which set `WEBSITE_CONTENTAZUREFILECONNECTIONSTRING` to store their content share on Azure Files. It does **not** apply to:

- **Dedicated (App Service) plans** — no content-share dependency.
- **Flex Consumption** — deploys from blob storage, not an SMB-mounted file share, so none of this SMB compatibility boundary applies.

If removing the Azure Files/storage-account-key dependency entirely (rather than just hardening its SMB settings) is the longer-term goal, Microsoft documents deploying from a blob-storage package URL via `WEBSITE_RUN_FROM_PACKAGE` (optionally with a managed identity) instead — see [Storage considerations for Azure Functions — Create an app without Azure Files](https://learn.microsoft.com/en-us/azure/azure-functions/storage-considerations#create-an-app-without-azure-files). That's a migration decision (it gives up the shared writable file system and in-portal code editing), not a settings change.

---

## References

1. **[SMB file shares in Azure Files](https://learn.microsoft.com/en-us/azure/storage/files/files-smb-protocol)** — Microsoft Learn. Primary source for every SMB security setting, its supported values, and the exact caveats quoted throughout this document.
2. **[Storage considerations for Azure Functions](https://learn.microsoft.com/en-us/azure/azure-functions/storage-considerations)** — Microsoft Learn. Describes the Azure Files content-share role for Consumption/Premium plans, the `WEBSITE_RUN_FROM_PACKAGE` dependency on it, and the option to run without Azure Files.
3. **[Overview — Azure Files identity-based authentication](https://learn.microsoft.com/en-us/azure/storage/files/storage-files-active-directory-overview)** — Microsoft Learn. Explains the three Kerberos identity sources (AD DS, Microsoft Entra Domain Services, Microsoft Entra Kerberos) and their domain-joined/Entra-joined client requirements.
4. **[Require secure transfer for Azure Storage](https://learn.microsoft.com/en-us/azure/storage/common/storage-require-secure-transfer)** — Microsoft Learn. Clarifies how the account-level *Secure transfer required* setting relates to the per-share *Require Encryption in Transit for SMB* setting.
5. **[Troubleshoot Azure Files SMB connectivity and access issues](https://learn.microsoft.com/en-us/troubleshoot/azure/azure-storage/files/connectivity/files-troubleshoot-smb-connectivity)** — Microsoft Learn. Background on SMB session-setup failures (`STATUS_ACCESS_DENIED`) when client and server security settings don't intersect.
6. **[App settings reference for Azure Functions — `WEBSITE_CONTENTAZUREFILECONNECTIONSTRING`](https://learn.microsoft.com/en-us/azure/azure-functions/functions-app-settings#website_contentazurefileconnectionstring)** — Microsoft Learn.
7. **[`Set-SmbClientConfiguration`](https://learn.microsoft.com/en-us/powershell/module/smbshare/set-smbclientconfiguration)** — Microsoft Learn (PowerShell reference). The client-side cipher-preference command referenced in §4, which cannot be run against Functions' platform-managed compute.
8. **Live test evidence** — this repository's companion report, compiled from Azure CLI, Application Insights, and Azure Activity Log queries run directly against this environment: **https://claude.ai/code/artifact/3d52a5f7-8401-4ef8-bba4-1a0e5144d182**

---

*Compiled 2026-07-22 against subscription `6a3bb170-5159-4bff-860b-aa74fb762697`, resource group `Temp_Function_RG`. See `README.md` in this repository for how to reproduce these tests.*
