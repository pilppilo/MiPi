# PiDu relay

`POST /api/relay` lets PiDu (or any script with the token) talk to MiPi. The relay stays off for a lane until its GitHub Environment has `RELAY_TOKEN`. The `relay:pidu` binding starts on MiPi. Ask MiPi through the web or Telegram to bind it to a purpose bot, for example “Bind relay:pidu to the PiDu bot.” Recent relay requests can still be polled after a rebind. If that bot is archived, the relay falls back to MiPi until the bot is restored or the owner rebinds it.

**1. GitHub: store the token.** Make 32 or more random letters and digits (a password manager's generator with symbols off). Settings → Environments → `staging` (or `production`) → Environment secrets → Add environment secret: name `RELAY_TOKEN`, value the token. Give the same token to PiDu.

**2. Cloudflare: let the relay past Access.** Zero Trust → Access controls → Applications → Add an application → Self-hosted. Name it `mipi-staging-relay`, use the lane's hostname with **Path** `api/relay` (no leading slash), and add a policy with **Action: Bypass**, **Include: Everyone**. The path covers `api/relay/<key>` too. The Worker checks the token itself on both routes, and every other route keeps its own authentication.

**3. Deploy.** Merging to `main` deploys staging. A token added after a deploy takes effect on the next one: Actions → deploy → Run workflow → target.

**4. Use it.**

```sh
curl -sS -X POST "$URL/api/relay" \
  -H "Authorization: Bearer $RELAY_TOKEN" -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" -d '{"text":"What is on my list today?"}'
```

- The `Idempotency-Key` is 1 to 64 letters, digits, `-` or `_`. Sending the same key again returns the first answer and admits nothing. The same key with a different text gets `409`.
- The request waits up to 25 seconds. `200 {"id","status":"done","answer"}` is the answer. `202 {"id","status":"pending"}` means it isn't ready yet: poll `GET /api/relay/<key>` with the same token. A turn that ends without an answer is `200 {"status":"unanswered","reason"}`.
- Text is at most 16,384 UTF-8 bytes (`413`), and at most 60 messages are admitted per sliding hour (`429` with `Retry-After`). A wrong token is `401`, and maintenance is `503`.

**Rotating the token.** Put the new token in `RELAY_TOKEN` and the old one in `RELAY_TOKEN_PREVIOUS`, then deploy: both work. Give PiDu the new token, delete `RELAY_TOKEN_PREVIOUS`, and deploy again: the old one stops working. Deleting `RELAY_TOKEN` and deploying turns the relay off.

**Verify.**

- The curl above answers `200` with an answer, or `202` and then the answer from `GET /api/relay/<key>`.
- The same curl with the same key returns the same answer.
- A wrong token answers `401 {"error":"Unauthorized"}` on both routes.
- Signed out, an owner route such as `GET /api/unlock` is still refused by Access.
