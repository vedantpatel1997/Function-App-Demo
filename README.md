# SMB Content-Share Repro — Queue Trigger Function App

Repro environment for support case **2606020040009172** (Sev B): a customer's
Queue-triggered Function App stops processing messages promptly (drops to
roughly once/day) when the backing storage account's Azure Files **SMB
security profile** is switched to **Maximum security**, and recovers
immediately when reverted to **Maximum compatibility** — even though the
function's own code never touches Azure Files.

This project deploys a minimal queue-triggered function into a **Windows
Consumption (Y1)** plan — the same plan class as the customer — so the
platform-managed **Azure Files content share** (used by Consumption/Premium
plans to store and load your function code) is present and can be toggled
the same way.

## Why this matters (root cause recap)

On Windows Consumption/Premium plans, the Functions platform stores your
app's code/config in an Azure Files share and mounts it over **SMB** using
the storage account key (`WEBSITE_CONTENTAZUREFILECONNECTIONSTRING` /
`WEBSITE_CONTENTSHARE` app settings — Azure Files has no identity-based
connection option). That key-based mount authenticates with **NTLMv2**.

The **Maximum security** SMB profile is Kerberos-only and removes NTLMv2, so
new SMB sessions to the content share fail (`STATUS_ACCESS_DENIED`).
Already-mounted instances keep running (SMB Continuous Availability), but
once the app idles/unloads (normal on Consumption) the platform can't
re-mount the content share on a fresh instance, so it can't scale out to
drain the queue. A batch only gets processed when a periodic platform
recycle briefly succeeds — hence "once a day."

The queue itself is unaffected — Queue storage is accessed over HTTPS/REST,
which the SMB profile doesn't govern. This is why it looks like a queue
trigger bug but is actually a content-share mount problem.

## Resources created

All resources live in resource group **`Temp_Function_RG`**
(subscription `6a3bb170-5159-4bff-860b-aa74fb762697`, region **`westus2`**).

| Resource | Name | Notes |
|---|---|---|
| Storage account | `tempfuncsmbstuw36s0` | StorageV2, Standard_LRS. Hosts `AzureWebJobsStorage`, the test queue, **and** the Functions content share. |
| Function App | `temp-func-smb-repro-uw36s0` | Windows, **Consumption (Y1)** plan, Node.js 24, Functions runtime `~4`. |
| Queue | `smb-repro-queue` | Trigger source for the function. |
| Function | `QueueTriggerRepro` | Logs the message content, a UTC timestamp, and the invocation ID on every run. |

App settings of interest (already present, confirmed during setup):
- `WEBSITE_CONTENTAZUREFILECONNECTIONSTRING` — key-based connection string to the content share (this is the NTLMv2-dependent mount).
- `WEBSITE_CONTENTSHARE` — `temp-func-smb-repro-uw36s049b40edaa66c`

Application Insights was auto-provisioned alongside the Function App for log querying.

## Project structure

```
Function App Demo/
├── host.json                       Functions host config (extension bundle v4)
├── package.json                    Node project manifest
├── local.settings.json             Local-only settings (gitignored; uses Azurite by default)
├── src/
│   └── functions/
│       └── QueueTriggerRepro.js    The queue-triggered function
└── README.md                       This file
```

`QueueTriggerRepro.js` binds to queue `smb-repro-queue` via connection
`AzureWebJobsStorage` and logs:

```js
context.log(`Processed message: "${queueItem}" | processedAt=${processedAt} | invocationId=${context.invocationId}`);
```

The timestamp is what you'll use to measure processing delay when you flip
the SMB profile.

## Prerequisites (only needed if you want to redeploy or run locally)

- Azure CLI, logged into the right subscription (`az account show` should show `6a3bb170-5159-4bff-860b-aa74fb762697`)
- Azure Functions Core Tools v4 (`func --version`)
- Node.js 20+ (project was deployed with Node 24, since Node 20 reached end-of-life 2026-04-30)

## Redeploying the code

From this folder:

```powershell
func azure functionapp publish temp-func-smb-repro-uw36s0
```

## How to trigger and verify it's working (baseline)

You need the storage account key for data-plane queue operations (no Queue
Data RBAC role is assigned to interactive logins by default on this
subscription):

```powershell
$RG  = "Temp_Function_RG"
$SA  = "tempfuncsmbstuw36s0"
$KEY = az storage account keys list -n $SA -g $RG --query "[0].value" -o tsv
```

**1. Send a test message:**

```powershell
az storage message put --queue-name smb-repro-queue --account-name $SA --account-key $KEY --content "hello-$(Get-Date -Format o)"
```

**2. Confirm it was processed — the queue should drain within a few seconds:**

```powershell
az storage message peek --queue-name smb-repro-queue --account-name $SA --account-key $KEY --num-messages 5
```

An empty `[]` result means the function dequeued and completed
successfully (on failure, the message becomes invisible for 30s then
reappears instead of being deleted).

**3. (Optional) See the actual log line in Application Insights:**

```powershell
$APP = "temp-func-smb-repro-uw36s0"
az monitor app-insights query --app $APP -g $RG `
  --analytics-query "traces | where message contains 'Processed message' | order by timestamp desc | take 5 | project timestamp, message" -o table
```

Note: ingestion can lag a minute or two and is sampled — the queue-drain
check in step 2 is the faster/more reliable signal.

**4. Alternative: trigger and watch live from the Portal**

Azure Portal → `temp-func-smb-repro-uw36s0` → Functions → `QueueTriggerRepro`
→ **Code + Test** → **Test/Run** tab lets you send a manual queue message,
or use **Monitor** to see recent invocations. **Log stream** (under the
function app, not the function) shows live console output — start it before
sending a message via CLI/Portal.

This baseline confirms the app is healthy end-to-end today, while the
storage account's file share is on its default (Maximum compatibility) SMB
settings.

## Reproducing the SMB "Maximum security" behavior

This is the actual repro for the case. The idea is a one-variable A/B: hold
everything else constant, flip only the file service SMB security profile,
and force a fresh SMB session by restarting the app (already-open handles
survive under Continuous Availability, so a restart is required to see the
mount actually get rejected).

**Step 1 — Apply "Maximum security"**

Portal: Storage account → **Data storage → File shares** → **File share
settings** → **Security** → Profile = **Maximum security** → Save.

Or CLI:

```powershell
az storage account file-service-properties update -n tempfuncsmbstuw36s0 -g Temp_Function_RG `
  --versions "SMB3.1.1" `
  --auth-methods "Kerberos" `
  --kerb-ticket-encryption "AES-256" `
  --channel-encryption "AES-256-GCM"
```

**Step 2 — Force a fresh mount:**

```powershell
az functionapp restart -n temp-func-smb-repro-uw36s0 -g Temp_Function_RG
```

**Step 3 — Re-run the trigger/verify steps above.** Expected: the message
sits in the queue and is not drained promptly (it may take a long time, or
only clear on the next platform recycle) — reproducing the customer's
symptom.

**Step 4 — Revert to confirm recovery:**

```powershell
az storage account file-service-properties update -n tempfuncsmbstuw36s0 -g Temp_Function_RG `
  --versions "SMB2.1;SMB3.0;SMB3.1.1" `
  --auth-methods "NTLMv2;Kerberos" `
  --kerb-ticket-encryption "RC4-HMAC;AES-256" `
  --channel-encryption "AES-128-CCM;AES-128-GCM;AES-256-GCM"

az functionapp restart -n temp-func-smb-repro-uw36s0 -g Temp_Function_RG
```

Re-run the trigger/verify steps once more — the backlog should drain
immediately again, isolating the SMB profile as the variable that matters.

## Cleanup

These are billed resources (Consumption plan is pay-per-execution, so idle
cost is minimal, but the storage account and Function App shell still
exist). When you're done testing, remove everything with:

```powershell
az group delete -n Temp_Function_RG --yes --no-wait
```

Only run this if `Temp_Function_RG` doesn't contain other resources you
still need — it deletes the entire resource group, not just what this
project created.
