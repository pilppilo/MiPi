# Using the Vault

Open **Vault** from the web app's Spaces menu or phone tabs. Use this space for bot secrets such as API keys and tokens. Enter their values here and keep them out of chat, Telegram and hints. MiPi encrypts the value and shows only the metadata after saving.

## Set up the lane key

1. In **Vault**, choose **Make a lane key**, then **Copy**. The browser generates the key in the tab.
2. In the MiPi GitHub repository, go to **Settings → Environments → staging → Add environment secret**. Name it `MIPI_VAULT_KEY` and paste the key.
3. Dismiss the key in Vault. For production, generate a fresh key and add it to the **production** environment.
4. After the lane deploys with the key, reopen Vault. Keep a secure copy of each lane key so you can restore its backups.

If Vault is locked, its banner shows the reason. You can still edit metadata or revoke access, inspect the audit and delete bot secrets. Adding a secret or replacing its value requires an open vault. Follow the deployment guide when changing the lane key for an existing vault. [Vault key rotation](deployment.md#the-vault-key).

## Add or change a bot secret

1. Choose **Add secret** and enter a category such as `token`, a name, an optional hint and the secret value. MiPi values must have at least eight characters.
2. Choose **No bot access**, **Ask for approval** or **Allow eligible reads**. Select each bot that should be allowed to use the secret. Archived grants stay visible so you can revoke them. An empty list grants access to no bots.
3. Enter exact HTTPS hostnames. Leave the port blank for 443. Choose the HTTP methods and optionally enter path prefixes such as `/projects`. A prefix matches complete path segments.
4. Enter the header name and a template with one `{}` placeholder. For bearer tokens, use `Authorization` and `Bearer {}`. Add an expiry if the grant should end at a specific time, then save.

Use **Edit → Replace value** to rotate a stored token. The input opens blank. The secret keeps its ID and audit trail. **Delete** removes the secret and keeps its audit on the server.

## Check how a secret was used

Each card shows its latest audit time, or **Never used**. Choose **View audit** to see the calling bot, tool, HTTP method, destination, decision and status or reason. The audit lists newest entries first and omits URL query strings.

The separate bot-tool rollout enables bots to use the policies configured here. Personal vault items are planned separately.
